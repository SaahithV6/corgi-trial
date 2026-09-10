/**
 * USDC payout rail adapter — Base Sepolia testnet.  DRAFT / research spike.
 *
 * TESTNET ONLY. $0. No real money, ever. The key this module loads must never
 * hold, and must never have held, real funds.
 *
 * Shape goal: this is *the same adapter interface an ACH rail implements*.
 * A rail is an adapter, not a schema. The ledger speaks
 *   initiate -> pending -> confirmed | failed
 * and never learns the words "gas", "nonce" or "Base". All chain-specific facts
 * are quarantined in `RailEvent.metadata`.
 *
 * Verified against real sources on 2026-09-09:
 *   - viem 2.56.3 (npm dist-tags `latest`); exports below checked in its .d.ts
 *   - USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e on Base Sepolia:
 *       decimals() -> 6, symbol() -> "USDC", not behind an EIP-1967 proxy
 *       (live eth_call against https://sepolia.base.org)
 *   - chainId 84532; measured block time exactly 2.0s over 100 blocks
 * See ./NOTES.md for citations.
 *
 * Anything marked `// UNVERIFIED:` is a shape I have NOT compiled or executed —
 * mostly the persistence interface, which is ours to define.
 */

import 'server-only' // UNVERIFIED: assumes Next.js App Router; drop in a plain-node context.

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  getAddress,
  isAddress,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Circle's official USDC on Base Sepolia. Source: developers.circle.com/stablecoins/usdc-contract-addresses */
export const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

/** VERIFIED on-chain via decimals(). Do not hardcode from memory elsewhere. */
export const USDC_DECIMALS = 6

/** VERIFIED via eth_chainId -> 0x14a34. */
export const BASE_SEPOLIA_CHAIN_ID = 84532

/** VERIFIED: 200s across 100 blocks. Base is a fixed-2s OP-Stack L2. */
export const BLOCK_TIME_SECONDS = 2

/**
 * Blocks to wait before emitting `payout.confirmed`.
 * 2 blocks ~= 4s. Base Sepolia has a single sequencer, so L1-style "wait 12"
 * buys nothing. NOTE: sequencer-confirmed != L1-finalized (~10-20 min).
 */
const DEFAULT_CONFIRMATIONS = 2

/** Minimal ERC-20 surface. `as const` is REQUIRED for viem's type inference. */
export const ERC20_MIN_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

// ===========================================================================
// MONEY CONVERSION — the single most important part of this file.
// ===========================================================================
//
//   ledger   : USD CENTS,       2dp, 1 unit = $0.01,      bigint
//   on-chain : USDC base units, 6dp, 1 unit = $0.000001,  bigint (uint256)
//
// THE RULE
//   1 cent === 10_000 USDC base units.
//   cents -> units is EXACT and always safe.
//   units -> cents is LOSSY and must be an explicit, named decision.
//   A JS `number` / float must NEVER touch either side of this conversion.
//
// Why: uint256 blows past Number.MAX_SAFE_INTEGER (~9.007e15) immediately, and
// 0.1 + 0.2 !== 0.3. Both failure modes silently corrupt a ledger.
// ---------------------------------------------------------------------------

/** 10n ** (6n - 2n). The whole conversion, in one constant. */
export const CENTS_TO_USDC_UNITS = 10_000n

/**
 * cents -> USDC base units. Exact, lossless, total. Cannot lose money:
 * 6dp is strictly finer than 2dp, so every cent has an exact unit value.
 *
 * Examples (unit-test style):
 *   usdcUnitsFromCents(0n)      === 0n
 *   usdcUnitsFromCents(1n)      === 10_000n         // $0.01
 *   usdcUnitsFromCents(100n)    === 1_000_000n      // $1.00
 *   usdcUnitsFromCents(2_500n)  === 25_000_000n     // $25.00
 *   usdcUnitsFromCents(999_99n) === 999_990_000n    // $999.99
 *   usdcUnitsFromCents(-1n)     -> throws (negative payouts are a caller bug)
 */
export function usdcUnitsFromCents(cents: bigint): bigint {
  if (typeof cents !== 'bigint') {
    throw new TypeError('amountCents must be a bigint — never a number or a float')
  }
  if (cents < 0n) throw new RangeError(`amountCents must be >= 0, got ${cents}`)
  return cents * CENTS_TO_USDC_UNITS
}

/**
 * USDC base units -> cents, STRICT. Throws on sub-cent dust rather than
 * silently truncating. Use for anything we originated (always cent-aligned).
 *
 * Examples:
 *   centsFromUsdcUnitsExact(10_000n)     === 1n
 *   centsFromUsdcUnitsExact(1_000_000n)  === 100n
 *   centsFromUsdcUnitsExact(25_000_000n) === 2_500n
 *   centsFromUsdcUnitsExact(1_000_001n)  -> throws  // 100.0001 cents: no ledger home
 *   centsFromUsdcUnitsExact(1n)          -> throws  // $0.000001 dust
 */
export function centsFromUsdcUnitsExact(units: bigint): bigint {
  if (typeof units !== 'bigint') throw new TypeError('units must be a bigint')
  if (units % CENTS_TO_USDC_UNITS !== 0n) {
    throw new RangeError(
      `${units} USDC base units is not a whole number of cents ` +
        `(remainder ${units % CENTS_TO_USDC_UNITS} sub-cent units)`,
    )
  }
  return units / CENTS_TO_USDC_UNITS
}

/**
 * USDC base units -> { cents, dustUnits }, LENIENT. For INBOUND amounts we did
 * not originate (deposits, refunds, third-party transfers) which may carry
 * sub-cent dust. Credit `cents`, park `dustUnits` in a dust account.
 * Never round dust away — money lost to a rounding mode is the worst ledger bug.
 *
 * Examples:
 *   splitUsdcUnits(1_000_000n) -> { cents: 100n, dustUnits: 0n }
 *   splitUsdcUnits(1_000_001n) -> { cents: 100n, dustUnits: 1n }
 *   splitUsdcUnits(9_999n)     -> { cents: 0n,   dustUnits: 9_999n }
 *   // invariant, always: cents * 10_000n + dustUnits === input
 */
export function splitUsdcUnits(units: bigint): { cents: bigint; dustUnits: bigint } {
  if (typeof units !== 'bigint') throw new TypeError('units must be a bigint')
  if (units < 0n) throw new RangeError('units must be >= 0')
  return { cents: units / CENTS_TO_USDC_UNITS, dustUnits: units % CENTS_TO_USDC_UNITS }
}

/**
 * Display only. NEVER feed the output back into arithmetic.
 *   formatUsdcUnits(1_000_000n) === '1'
 *   formatUsdcUnits(1_234_560n) === '1.23456'
 * (viem's formatUnits trims trailing zeros — pad in the UI layer, not here.)
 */
export function formatUsdcUnits(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS)
}

/**
 * Parse boundary only (e.g. a human-typed "12.34"). Exact decimal string -> bigint.
 *   parseUsdcAmount('1')     === 1_000_000n
 *   parseUsdcAmount('0.01')  === 10_000n
 *   parseUsdcAmount('12.34') === 12_340_000n
 */
export function parseUsdcAmount(decimalString: string): bigint {
  return parseUnits(decimalString, USDC_DECIMALS)
}

/** JSON has no bigint (JSON.stringify(1n) throws). Amounts cross boundaries as decimal STRINGS. */
export const serializeAmount = (v: bigint): string => v.toString()
export const deserializeAmount = (s: string): bigint => BigInt(s)

// ---------------------------------------------------------------------------
// Rail event vocabulary — identical to what an ACH adapter emits.
// ---------------------------------------------------------------------------

export type RailEventType =
  | 'payout.initiated' // ACH: file submitted   | USDC: signed + broadcast, hash known
  | 'payout.pending' // ACH: in flight        | USDC: in mempool / < N confirmations
  | 'payout.confirmed' // ACH: settled          | USDC: receipt success at N confirmations
  | 'payout.failed' // ACH: returned (R01)   | USDC: receipt reverted, or permanently dropped

export type PayoutStatus = 'initiated' | 'pending' | 'confirmed' | 'failed'

export interface RailEvent {
  type: RailEventType
  rail: 'usdc_base_sepolia'
  /** Our idempotency key — the stable join back to the ledger row. */
  idempotencyKey: string
  /** Decimal STRING, never a number. See serializeAmount. */
  amountCents: string
  occurredAt: string // ISO 8601
  /** Rail-specific facts live here ONLY. The ledger core never reads this. */
  metadata: {
    txHash?: Hex
    nonce?: number
    blockNumber?: string
    confirmations?: string
    gasUsed?: string
    effectiveGasPrice?: string
    explorerUrl?: string
    /** 'replaced' | 'repriced' | 'cancelled' when viem's onReplaced fires. */
    replacementReason?: string
    failureReason?: string
  }
}

export interface SendUsdcParams {
  to: string
  amountCents: bigint
  idempotencyKey: string
}

export interface SendUsdcResult {
  status: PayoutStatus
  txHash: Hex
  nonce: number
  amountCents: bigint
  amountUsdcUnits: bigint
  explorerUrl: string
  events: RailEvent[]
}

// ---------------------------------------------------------------------------
// Persistence port. UNVERIFIED: this whole interface is ours to define; the
// real one will be Drizzle/Kysely over Postgres. Shape is what matters here.
//
// Required schema constraints (these ARE the idempotency guarantee):
//   payout_attempt.idempotency_key  UNIQUE NOT NULL
//   payout_attempt.nonce            UNIQUE NOT NULL   (per sender address)
//   payout_attempt.tx_hash          NOT NULL          (written BEFORE broadcast)
//   amounts stored as BIGINT, read back as string -> BigInt(), never as number
// ---------------------------------------------------------------------------

export interface PayoutAttemptRow {
  idempotencyKey: string
  to: Address
  amountCents: bigint
  nonce: number
  txHash: Hex
  serializedTransaction: Hex
  status: PayoutStatus
  /** Guards against a key being reused with different params. */
  paramsFingerprint: Hex
}

export interface PayoutStore {
  findByIdempotencyKey(key: string): Promise<PayoutAttemptRow | null>
  /**
   * MUST run inside one transaction that holds a row lock on the sender wallet
   * (SELECT ... FOR UPDATE, or pg_advisory_xact_lock) for the whole callback,
   * so concurrent Vercel lambdas cannot allocate the same nonce.
   * `startingNonce` is eth_getTransactionCount(sender, 'pending') for seeding.
   */
  withNonceLock<T>(sender: Address, fn: (allocateNonce: () => Promise<number>) => Promise<T>): Promise<T>
  /** INSERT ... ; the UNIQUE indexes are what actually win the race. */
  insertAttempt(row: PayoutAttemptRow): Promise<void>
  updateStatus(key: string, status: PayoutStatus): Promise<void>
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function rpcUrl(): string {
  return process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
}

/** Lazy so a missing env var fails loudly at request time, not confusingly at build time. */
function serverAccount() {
  const pk = process.env.BASE_SEPOLIA_PRIVATE_KEY
  if (!pk) throw new Error('BASE_SEPOLIA_PRIVATE_KEY is not set')
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error('BASE_SEPOLIA_PRIVATE_KEY must be 0x-prefixed, 64 hex chars')
  }
  return privateKeyToAccount(pk as Hex)
}

export const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl()),
})

function walletClient() {
  const client = createWalletClient({
    account: serverAccount(),
    chain: baseSepolia,
    transport: http(rpcUrl()),
  })
  // Defence in depth: a config slip that points this key at mainnet must be impossible.
  if (client.chain.id !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`refusing to sign on chain ${client.chain.id}; expected Base Sepolia`)
  }
  return client
}

const explorerUrl = (hash: Hex) => `https://sepolia.basescan.org/tx/${hash}`

// ---------------------------------------------------------------------------
// getUsdcBalance
// ---------------------------------------------------------------------------

/**
 * Read a USDC balance. Returns base units AND the cents split, so the caller
 * never has to remember the 10_000 factor.
 *
 * Examples (against a faucet-funded address holding exactly 20 USDC):
 *   -> { units: 20_000_000n, cents: 2_000n, dustUnits: 0n, display: '20' }
 */
export async function getUsdcBalance(address: string): Promise<{
  units: bigint
  cents: bigint
  dustUnits: bigint
  display: string
}> {
  const addr = assertAddress(address)
  const units = await publicClient.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: [addr],
  })
  const { cents, dustUnits } = splitUsdcUnits(units)
  return { units, cents, dustUnits, display: formatUsdcUnits(units) }
}

function assertAddress(a: string): Address {
  if (!isAddress(a)) throw new Error(`not a valid address: ${a}`)
  const checksummed = getAddress(a)
  if (checksummed === '0x0000000000000000000000000000000000000000') {
    throw new Error('refusing to send to the zero address')
  }
  return checksummed
}

// ---------------------------------------------------------------------------
// sendUsdc — initiate. Idempotent by construction.
// ---------------------------------------------------------------------------

/**
 * The ordering below is the entire safety argument:
 *
 *   1. idempotency-key lookup      -> replay returns the stored result, no chain call
 *   2. allocate nonce under a DB lock
 *   3. SIGN LOCALLY (offline, deterministic)
 *   4. hash = keccak256(serialized)  <- hash is known BEFORE the network hears anything
 *   5. INSERT row (UNIQUE key, UNIQUE nonce) and COMMIT
 *   6. sendRawTransaction           <- only now can money move
 *
 * `writeContract()` is NOT used, because it fuses nonce-pick + sign + broadcast
 * into one opaque step: crash between broadcast and DB-write and you have an
 * unrecorded on-chain payment. Splitting sign from broadcast removes that window.
 *
 * Two transactions with the same (sender, nonce) can never both be mined — that
 * is a consensus guarantee, and it is stronger than any application-level dedupe.
 * Re-broadcasting the byte-identical signed payload yields the identical hash and
 * is a no-op ("already known"), never a second payment.
 *
 * Returns as soon as it is broadcast. Does NOT block on confirmation — a Vercel
 * request handler must not sit on a 90s wait. Confirmation is a separate poll,
 * which is also the correct ACH-shaped design.
 */
export async function sendUsdc(
  params: SendUsdcParams,
  store: PayoutStore, // UNVERIFIED: injected for now; will be a module import.
): Promise<SendUsdcResult> {
  const { amountCents, idempotencyKey } = params
  const to = assertAddress(params.to)
  const now = () => new Date().toISOString()

  if (typeof amountCents !== 'bigint') {
    throw new TypeError('amountCents must be a bigint — never a number or a float')
  }
  if (amountCents <= 0n) throw new RangeError('amountCents must be > 0')

  const maxCents = BigInt(process.env.USDC_MAX_PAYOUT_CENTS ?? '100000')
  if (amountCents > maxCents) {
    throw new RangeError(`amountCents ${amountCents} exceeds cap ${maxCents}`)
  }

  const amountUsdcUnits = usdcUnitsFromCents(amountCents) // exact, always
  const fingerprint = keccak256(
    // UNVERIFIED: encoding choice is arbitrary; any stable canonical form works.
    Buffer.from(`${to}:${amountCents.toString()}`, 'utf8') as unknown as Hex,
  )

  // --- 1. Replay? ----------------------------------------------------------
  const existing = await store.findByIdempotencyKey(idempotencyKey)
  if (existing) {
    if (existing.paramsFingerprint !== fingerprint) {
      // Caller bug. Silently sending the OLD amount would hide it.
      throw new Error(
        `idempotency key ${idempotencyKey} was already used with different parameters`,
      )
    }
    return {
      status: existing.status,
      txHash: existing.txHash,
      nonce: existing.nonce,
      amountCents: existing.amountCents,
      amountUsdcUnits: usdcUnitsFromCents(existing.amountCents),
      explorerUrl: explorerUrl(existing.txHash),
      events: [], // already emitted on the original pass
    }
  }

  const client = walletClient()
  const sender = client.account.address

  // --- 2..5. Allocate nonce, sign, persist — all before broadcast ----------
  const { row, serialized } = await store.withNonceLock(sender, async (allocateNonce) => {
    const nonce = await allocateNonce()

    // UNVERIFIED: exact prepare/sign call shape not compiled. viem 2.x exposes
    // prepareTransactionRequest + signTransaction on the wallet client; the
    // gas/fee fields it fills are what we want, we only pin the nonce.
    const request = await client.prepareTransactionRequest({
      to: USDC_BASE_SEPOLIA,
      data: encodeTransferData(to, amountUsdcUnits),
      nonce,
      value: 0n,
    })
    const serializedTransaction = (await client.signTransaction(request as never)) as Hex

    // The hash of a signed tx is keccak256 of its serialization — deterministic,
    // computable offline. This is why we can record it before broadcasting.
    const txHash = keccak256(serializedTransaction)

    const attempt: PayoutAttemptRow = {
      idempotencyKey,
      to,
      amountCents,
      nonce,
      txHash,
      serializedTransaction,
      status: 'initiated',
      paramsFingerprint: fingerprint,
    }
    await store.insertAttempt(attempt) // UNIQUE(idempotency_key), UNIQUE(nonce)
    return { row: attempt, serialized: serializedTransaction }
  })

  // --- 6. Broadcast --------------------------------------------------------
  // Re-broadcasting this exact payload later is safe and idempotent.
  await client.sendRawTransaction({ serializedTransaction: serialized })
  await store.updateStatus(idempotencyKey, 'pending')

  const base = {
    rail: 'usdc_base_sepolia' as const,
    idempotencyKey,
    amountCents: serializeAmount(amountCents),
  }
  const events: RailEvent[] = [
    {
      ...base,
      type: 'payout.initiated',
      occurredAt: now(),
      metadata: { txHash: row.txHash, nonce: row.nonce, explorerUrl: explorerUrl(row.txHash) },
    },
    {
      ...base,
      type: 'payout.pending',
      occurredAt: now(),
      metadata: { txHash: row.txHash, nonce: row.nonce, explorerUrl: explorerUrl(row.txHash) },
    },
  ]

  return {
    status: 'pending',
    txHash: row.txHash,
    nonce: row.nonce,
    amountCents,
    amountUsdcUnits,
    explorerUrl: explorerUrl(row.txHash),
    events,
  }
}

/** transfer(address,uint256) calldata. Kept separate so the ABI stays the only source of truth. */
function encodeTransferData(to: Address, value: bigint): Hex {
  // UNVERIFIED: import encodeFunctionData from 'viem' in the real module.
  // return encodeFunctionData({ abi: ERC20_MIN_ABI, functionName: 'transfer', args: [to, value] })
  throw new Error('not implemented in draft — use viem encodeFunctionData')
}

// ---------------------------------------------------------------------------
// getTransactionStatus — pending -> confirmed | failed
// ---------------------------------------------------------------------------

export interface TransactionStatus {
  status: PayoutStatus
  txHash: Hex
  confirmations: bigint
  blockNumber?: bigint
  receipt?: TransactionReceipt
  replacementReason?: 'replaced' | 'repriced' | 'cancelled'
  failureReason?: string
  event?: RailEvent
}

/**
 * Poll a broadcast transaction. Safe to call repeatedly; it is a pure read.
 *
 * Three distinct failure modes, three distinct detections:
 *   reverted  -> receipt EXISTS with status 'reverted' (gas burned, no transfer)
 *   replaced  -> a different tx with the SAME NONCE mined; viem's onReplaced fires
 *   dropped   -> no receipt before timeout; AMBIGUOUS, resolve by nonce, never by hope
 *
 * The rule that matters: a timeout means "don't know yet", NOT "did not happen".
 * We leave the row `pending` and let a reconciler retry. Auto-escalating a timeout
 * to `failed` is how you end up paying someone twice.
 */
export async function getTransactionStatus(
  txHash: Hex,
  opts: { idempotencyKey: string; amountCents: bigint; confirmations?: number; timeoutMs?: number },
): Promise<TransactionStatus> {
  const want = opts.confirmations ?? Number(process.env.USDC_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS)
  const base = {
    rail: 'usdc_base_sepolia' as const,
    idempotencyKey: opts.idempotencyKey,
    amountCents: serializeAmount(opts.amountCents),
  }
  let replacementReason: TransactionStatus['replacementReason']

  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: want,
      timeout: opts.timeoutMs ?? 90_000,
      pollingInterval: 1_000, // 2s blocks; 1s polling is plenty
      onReplaced: (r) => {
        replacementReason = r.reason // 'replaced' | 'repriced' | 'cancelled'
      },
    })

    const confirmations = await publicClient.getTransactionConfirmations({ hash: txHash })

    // USDC's FiatToken reverts rather than returning false, so a 'success'
    // receipt IS proof of transfer. But a receipt can exist and be reverted —
    // treating "receipt exists" as "paid" is the classic bug here.
    if (receipt.status === 'reverted') {
      return {
        status: 'failed',
        txHash,
        confirmations,
        blockNumber: receipt.blockNumber,
        receipt,
        replacementReason,
        failureReason: 'transaction reverted on-chain',
        event: {
          ...base,
          type: 'payout.failed',
          occurredAt: new Date().toISOString(),
          metadata: {
            txHash,
            blockNumber: receipt.blockNumber.toString(),
            gasUsed: receipt.gasUsed.toString(),
            failureReason: 'reverted',
            replacementReason,
            explorerUrl: explorerUrl(txHash),
          },
        },
      }
    }

    // UNVERIFIED (belt-and-braces, worth adding): parse the Transfer event out of
    // receipt.logs with parseEventLogs and assert from/to/value match intent,
    // rather than trusting that a success receipt did what we think it did.

    return {
      status: 'confirmed',
      txHash,
      confirmations,
      blockNumber: receipt.blockNumber,
      receipt,
      replacementReason,
      event: {
        ...base,
        type: 'payout.confirmed',
        occurredAt: new Date().toISOString(),
        metadata: {
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          confirmations: confirmations.toString(),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice.toString(),
          replacementReason,
          explorerUrl: explorerUrl(txHash),
        },
      },
    }
  } catch (err) {
    // Timeout / not-found. AMBIGUOUS — stay pending, emit nothing terminal.
    return {
      status: 'pending',
      txHash,
      confirmations: 0n,
      replacementReason,
      failureReason: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Disambiguate a stuck transaction by nonce. Call this from the reconciler when
 * getTransactionStatus has been returning `pending` for too long.
 *
 *   minedCount >  ourNonce -> SOMETHING at our nonce was mined. Find out what
 *                             before touching anything. Do NOT re-send.
 *   minedCount <= ourNonce -> nothing at our nonce is mined; re-broadcasting the
 *                             identical stored serializedTransaction is safe.
 */
export async function isNonceConsumed(sender: Address, nonce: number): Promise<boolean> {
  const mined = await publicClient.getTransactionCount({ address: sender, blockTag: 'latest' })
  return mined > nonce
}
