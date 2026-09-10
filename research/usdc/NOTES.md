# USDC payout rail — Base Sepolia testnet

Research notes for Corgi trial, Track 3. **Testnet only. $0 budget. No real money, ever.**

Researched 2026-09-09. Items marked **[VERIFIED ON-CHAIN]** were checked by live `eth_call` against
`https://sepolia.base.org` during this research. Items marked **[UNCONFIRMED]** are from secondary
sources and should be re-checked before relying on them.

---

## 1. Network + contract facts

### Base Sepolia network

| Field | Value | Source |
|---|---|---|
| Chain ID | **84532** (`0x14a34`) | [Base docs — Connecting to Base](https://docs.base.org/base-chain/quickstart/connecting-to-base) |
| Public RPC (no API key) | **`https://sepolia.base.org`** | same |
| Native currency | ETH (18 decimals) | same |
| Block explorer | `https://sepolia.basescan.org` | same |
| Measured block time | **2.0 s** (exact, averaged over 100 blocks) | measured live, see below |
| viem chain export | `import { baseSepolia } from 'viem/chains'` | verified in viem 2.56.3 `.d.ts` |

**[VERIFIED ON-CHAIN]** `eth_chainId` on `https://sepolia.base.org` returned `0x14a34` = 84532.

**[VERIFIED ON-CHAIN]** Block time: block `46616123` timestamp `1789000534`, block `46616023`
timestamp `1789000334` → 200 s / 100 blocks = **exactly 2.0 s per block**. Base is an OP-Stack L2
with a fixed 2 s block interval.

`https://sepolia.base.org` is the official Base-operated public endpoint and requires no API key or
signup. It is rate-limited (public commons). **[UNCONFIRMED]** exact published rate limit — Base has
historically documented something in the region of ~1000 req/min per IP for the public endpoint but
does not guarantee it. For the trial this is fine; for anything sustained, swap in an Alchemy /
QuickNode / Ankr Base Sepolia URL behind `BASE_SEPOLIA_RPC_URL` so the rail adapter never has to change.

**Design note:** put the RPC URL in an env var from day one. `http()` with no argument in viem falls
back to the chain's default RPC, which silently couples you to the public commons.

### USDC contract on Base Sepolia

```
0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

**Authoritative source:** Circle's official contract-address registry —
<https://developers.circle.com/stablecoins/usdc-contract-addresses> (Testnet tab, "Base Sepolia").
This is the canonical list; do not trust blog posts or aggregator sites for token addresses.

**[VERIFIED ON-CHAIN]** I called the contract directly on `https://sepolia.base.org`:

| Call | Selector | Raw result | Decoded |
|---|---|---|---|
| `decimals()` | `0x313ce567` | `0x…06` | **6** |
| `symbol()` | `0x95d89b41` | `…0455534443…` | `"USDC"` |
| `name()` | `0x06fdde03` | `…0455534443…` | `"USDC"` |
| `version()` | `0x54fd4d50` | `…0132…` | `"2"` (FiatTokenV2) |

So: **decimals = 6, confirmed against the live contract, not just the docs.** Note the testnet
deployment's `name()` is the bare string `"USDC"` (mainnet USDC's name is `"USD Coin"`) — harmless,
but don't assert on `name` in a test.

**[VERIFIED ON-CHAIN]** EIP-1967 implementation slot
(`0x360894…382bbc`) reads as zero → this deployment is **not** behind a proxy. It is a direct
FiatTokenV2 deployment. Practical consequence: the address cannot be upgraded out from under you
mid-trial, and there's no proxy indirection to confuse a gas estimate.

**Gotcha:** USDC's `transfer` returns `bool` and, on FiatToken, *reverts* on failure rather than
returning `false`. So a mined receipt with `status === 'success'` is sufficient proof of transfer —
you do not need to decode the return value. But **do** check `receipt.status`, because a receipt can
exist with `status === 'reverted'` (gas was burned, no transfer happened). Treating "receipt exists"
as "payment confirmed" is the classic bug here.

---

## 2. Faucets — 5-minute human checklist

You need **two** things: Base Sepolia **ETH** (to pay gas) and Base Sepolia **USDC** (the thing you're
sending). Two different faucets. Do them in this order.

### Checklist

- [ ] **1. Have the server wallet address ready.** Copy the `0x…` address of the wallet whose private
      key is (or will be) in `BASE_SEPOLIA_PRIVATE_KEY`. You need the *address*, never paste the key
      into a website.

- [ ] **2. Get testnet ETH for gas — Coinbase Developer Platform faucet.**
      Go to <https://portal.cdp.coinbase.com/products/faucet>.
      Sign in with a free CDP account (Google/email; **no mainnet balance and no social task required**).
      Select network **Base Sepolia**, asset **ETH**, paste your address, click *Request funds*.
      Drip: **0.1 ETH per 24 h per address**. Arrives in a few seconds.
      *0.1 ETH is enormous for this purpose — a USDC transfer on Base Sepolia costs on the order of
      1e-8 ETH. One claim funds thousands of payouts.*
      Source: [Coinbase Developer Platform — Faucets](https://www.coinbase.com/developer-platform/products/faucet),
      linked from [Base docs — Network faucets](https://docs.base.org/base-chain/network-information/network-faucets).

- [ ] **3. Get testnet USDC — Circle's public faucet.**
      Go to <https://faucet.circle.com>.
      **No account, no login, no wallet connection required** — it is public and permissionless.
      Select network **Base Sepolia**, asset **USDC**, paste your address, submit.
      Drip: **20 USDC per request**, limited to **one request per (asset, network) pair every 2 hours**.
      Source: [Circle Testnet Faucet](https://faucet.circle.com) — the page states
      "public and permissionless for anyone to use. There's no account required" and
      "One request per pairing of asset and test network every 2 hours."

- [ ] **4. Verify both balances before writing any code.**
      Open `https://sepolia.basescan.org/address/<your address>` — you should see an ETH balance and,
      under the token tab, 20 USDC. Or from the shell, no API key needed:
      ```bash
      # ETH balance
      curl -s -X POST https://sepolia.base.org -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xYOURADDRESS","latest"]}'

      # USDC balance: balanceOf(address) selector 0x70a08231 + 32-byte left-padded address
      curl -s -X POST https://sepolia.base.org -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","data":"0x70a08231000000000000000000000000YOURADDRESSWITHOUT0x"},"latest"]}'
      ```
      Result is hex base units; divide by 1e6 for a human USDC figure.

- [ ] **5. Pick a recipient.** Any second address works. A convenient trick for a demo: send to a
      *different* address you also control so you can show the balance moving on both sides. Do **not**
      generate that keypair inside this repo — use a throwaway from a browser wallet, or just hardcode a
      well-known burn-ish testnet address for the happy path.

**Backup ETH faucets** if CDP is down or you don't want an account. All **[UNCONFIRMED]** on current
drip amounts and gating — these change often:
- Alchemy — <https://www.alchemy.com/faucets/base-sepolia> (free Alchemy account; historically has
  required a small mainnet ETH balance on the address, which is a blocker for a fresh wallet)
- QuickNode — <https://faucet.quicknode.com/base/sepolia>
- Bware Labs — <https://bwarelabs.com/faucets/base-sepolia>

Prefer CDP: it's first-party to Base, it has no mainnet-balance gate, and 0.1 ETH/day is plenty.

**Rate-limit planning for the trial:** the binding constraint is Circle's **20 USDC / 2 h**. If your
demo sends $10.00 per payout you get ~2 payouts per faucet claim. So **make demo amounts small** —
send `amountCents = 1` ($0.01) in tests, and reserve a couple of dollar-sized sends for the recorded
walkthrough. Claim the faucet early, before you need it.

---

## 3. viem

**Current version: `viem@2.56.3`**, published 2026-09-02 (checked against the npm registry
`dist-tags` on 2026-09-09; `next` tag is `3.0.0-next.10` — do **not** use the v3 prerelease for a
48-hour trial). Peer dependency: `typescript >= 5.0.4`.

```bash
npm i viem@^2.56.3
```

All exports below were verified against the published `viem-2.56.3.tgz` type definitions:
`createPublicClient`, `createWalletClient`, `parseUnits`, `formatUnits`, `erc20Abi` from `viem`;
`privateKeyToAccount` from `viem/accounts`; `baseSepolia` from `viem/chains`.

### Minimal ABI

viem does ship `erc20Abi` from the root export, but hand-rolling the three entries you need keeps
the bundle and the mental model small, and makes it obvious which contract surface the rail touches.
`as const` is **mandatory** — it's what gives viem's type inference the literal types for
`functionName` and `args`.

```ts
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
] as const
```

(Add the `Transfer` event only if you want to parse it back out of the receipt logs to prove the
amount that actually moved — worth doing, see §5.)

### (a) Clients from a private key

```ts
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const rpc = http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org')

// must be 0x-prefixed, 32 bytes / 64 hex chars
const account = privateKeyToAccount(process.env.BASE_SEPOLIA_PRIVATE_KEY as `0x${string}`)

export const publicClient = createPublicClient({ chain: baseSepolia, transport: rpc })
export const walletClient = createWalletClient({ account, chain: baseSepolia, transport: rpc })
```

### (b) ERC-20 `transfer` for an integer amount

Simple form (fine for a first spike, **not** idempotent — see §5 for the version we ship):

```ts
const hash = await walletClient.writeContract({
  address: USDC_BASE_SEPOLIA,
  abi: ERC20_MIN_ABI,
  functionName: 'transfer',
  args: [to, amountBaseUnits],   // amountBaseUnits is a bigint
})
```

Source: [viem — writeContract](https://viem.sh/docs/contract/writeContract). Returns only the
transaction hash; it does **not** wait for mining.

### (c) Wait for the receipt, count confirmations

```ts
const receipt = await publicClient.waitForTransactionReceipt({
  hash,
  confirmations: 2,
  timeout: 90_000,
  pollingInterval: 1_000,
  onReplaced: (r) => { /* r.reason: 'replaced' | 'repriced' | 'cancelled' */ },
})
// receipt.status is 'success' | 'reverted'  <- always check this

const confirmations = await publicClient.getTransactionConfirmations({ hash })
// returns bigint; 0n means not yet confirmed
```

Sources: [waitForTransactionReceipt](https://viem.sh/docs/actions/public/waitForTransactionReceipt),
[getTransactionConfirmations](https://viem.sh/docs/actions/public/getTransactionConfirmations).
Defaults worth knowing: `confirmations` defaults to **1**, `timeout` to **180_000 ms**, `retryCount`
to **6**. `getTransactionConfirmations` accepts either `{ hash }` or `{ transactionReceipt }` and
returns a **bigint**.

### (d) Read an ERC-20 balance

```ts
const raw: bigint = await publicClient.readContract({
  address: USDC_BASE_SEPOLIA,
  abi: ERC20_MIN_ABI,
  functionName: 'balanceOf',
  args: [address],
})
```

---

## 4. Decimals and money handling — **the rule**

Two different integer scales are in play. Neither is ever a float.

```
ledger  : USD CENTS,        2 dp,  1 unit = $0.01,      TypeScript bigint (Postgres BIGINT)
on-chain: USDC base units,  6 dp,  1 unit = $0.000001,  TypeScript bigint (uint256)
```

### The rule, crisply

> **1 cent = 10,000 USDC base units.** Convert with integer `bigint` multiply/divide only.
> `cents → units` is exact and always safe. `units → cents` is **lossy** and must be an explicit,
> named decision — never an implicit truncation.
> **A JS `number` or a float must never touch either side of this conversion.**

```ts
const USDC_DECIMALS = 6n
const CENT_DECIMALS = 2n
const CENTS_TO_USDC = 10_000n   // 10n ** (6n - 2n)
```

### cents → USDC base units (exact, lossless, always safe)

```ts
function usdcUnitsFromCents(cents: bigint): bigint {
  return cents * CENTS_TO_USDC
}
// 1n      -> 10_000n            ($0.01)
// 100n    -> 1_000_000n         ($1.00)
// 2_500n  -> 25_000_000n        ($25.00)
```

Every cent value maps onto a distinct USDC unit value with zero remainder, because 6 dp is strictly
finer than 2 dp. This direction can never lose money.

### USDC base units → cents (LOSSY — this is where the risk lives)

```
1_000_000n units -> 100 cents  exactly
1_000_001n units -> 100.0001 cents  <- NOT representable in the ledger
```

The bottom **4 decimal digits** of any USDC amount have no home in a cents ledger. So:

```ts
function centsFromUsdcUnitsExact(units: bigint): bigint {
  if (units % CENTS_TO_USDC !== 0n) {
    throw new Error(`amount ${units} is not a whole number of cents`)
  }
  return units / CENTS_TO_USDC
}
```

**Where the rounding risk actually bites:**

1. **Inbound amounts we did not originate.** Anything we *send* is a multiple of 10,000 by
   construction, so it round-trips exactly. Anything we *receive* (a deposit, a refund, a
   third-party transfer) can carry sub-cent dust. Never silently `/ 10000n` it.
2. **Fees or FX in the middle.** If a future rail ever deducts an on-chain fee in USDC units, the
   net can stop being cent-aligned.
3. **Division before multiplication.** In any percentage/split math, multiply first, divide last, and
   decide the rounding direction explicitly.

**Policy for this system:** the ledger is the source of truth and speaks only whole cents. The rail
adapter accepts `amountCents: bigint`, converts *outbound* exactly, and on the *inbound* side splits
any non-cent-aligned amount into `credited cents` (floor) + a `dust_units` remainder held in a
separate dust account, rather than rounding it away. Money that vanishes into a rounding mode is the
single worst class of bug in a ledger.

### Never a float — how to actually enforce it

- **`bigint` everywhere.** `amountCents`, base units, balances. Postgres `BIGINT`, and read it back
  as a string → `BigInt(s)`, never via a driver that hands you a JS `number`.
  (`node-postgres` returns `int8` as a *string* by default — leave that alone, do not install a
  parser that converts it to `number`.)
- **`parseUnits` / `formatUnits`, not arithmetic.** `parseUnits('1.5', 6) === 1_500_000n`. Use these
  only at the *display/parse boundary*, never in the middle of a calculation.
- **Never `Number()`, `parseFloat`, `toFixed`, `*`/`/` on a float, or `JSON.parse` of a numeric
  amount.** `Number.MAX_SAFE_INTEGER` is ~9.007e15; a uint256 blows past it instantly, and
  `0.1 + 0.2 !== 0.3` blows past correctness immediately.
- **JSON has no bigint.** `JSON.stringify(1n)` throws. Serialise amounts as **decimal strings** at
  API/event boundaries (`"1000000"`), and parse with `BigInt()`. Pick this convention once and hold it.
- **Lint it.** A single ESLint rule banning `parseFloat`/`Number(` inside the money modules is cheap
  and catches the regression a teammate would otherwise introduce at 3am.

---

## 5. Confirmation semantics

### Block time and how many confirmations

**[VERIFIED ON-CHAIN]** Base Sepolia produces a block every **2.0 s**, deterministically.

| Confirmations | Wall clock | Use |
|---|---|---|
| 1 | ~2 s | mined, receipt available — enough to move `pending → confirmed` in a demo |
| **2–3** | **~4–6 s** | **recommended for the ledger `confirmed` event** |
| 12+ | ~24 s | cargo-culted from Ethereum L1 PoW; no added meaning here |

**Recommendation: `confirmations: 2`.** Rationale: Base is an OP-Stack L2 with a **single
sequencer**. There is no competing block production, so once the sequencer includes a transaction it
does not get reorged out under normal operation — the L1-style "wait 12 blocks for probabilistic
finality" model does not apply. Waiting 2 blocks (~4 s) buys you a cheap guard against a
sequencer-level reorg while keeping the demo snappy. Anything beyond ~3 is pure latency with no risk
reduction.

**The honest caveat, worth one line in the write-up:** L2 "confirmed" ≠ **final**. True finality
requires the batch to be posted to and finalized on Ethereum L1, which is on the order of
**10–20 minutes**. **[UNCONFIRMED]** exact current Base Sepolia batch cadence. For a testnet payout
demo, sequencer confirmation is the right bar, but the ledger should model this as
`confirmed` (sequencer, 2 blocks) with `finalized` available as a *later, optional* state rather than
pretending 2 blocks is settlement. Naming that distinction is itself high signal — it's exactly the
same shape as ACH: "submitted" is not "settled" is not "past the return window".

### Detecting a dropped or replaced transaction

Three distinct failure modes, three distinct detections:

1. **Reverted** — mined, but the contract threw (e.g. insufficient USDC balance).
   `receipt.status === 'reverted'`. **This still consumed gas and still produced a receipt.** Emit a
   `failed` event. Do not retry blindly; the balance problem won't fix itself.

2. **Replaced / repriced / cancelled** — a different transaction with the *same nonce* got mined
   instead. viem surfaces this via the `onReplaced` callback on `waitForTransactionReceipt`, with
   `reason` being one of `'replaced'` (payload changed), `'repriced'` (same payload, higher gas), or
   `'cancelled'` (a 0-value self-send used to void the nonce). The callback also hands you the
   replacement transaction, so you can follow the new hash. Detection mechanism: viem watches for a
   block containing a transaction from the same sender with the same nonce.

3. **Dropped / stuck** — never mined, evicted from the mempool (underpriced, or a node restart).
   `waitForTransactionReceipt` rejects with `WaitForTransactionReceiptTimeoutError` after `timeout`.
   This is the ambiguous case: **timeout does not mean "did not happen"**, it means "don't know yet".
   Resolve it by nonce, not by hope:
   ```ts
   const mined = await publicClient.getTransactionCount({ address: sender, blockTag: 'latest' })
   // mined > ourNonce  -> some tx at our nonce WAS mined; find out which one before doing anything
   // mined <= ourNonce -> nothing at our nonce is mined; safe to re-broadcast the identical raw tx
   ```
   Leave the ledger row `pending` and let a reconciler poll. **Never** auto-escalate a timeout to
   `failed` — that's how you pay someone twice.

**Belt-and-braces:** parse the `Transfer` event out of `receipt.logs` and assert `from`, `to`, and
`value` match what you intended, rather than trusting that a `status: 'success'` receipt for *some*
transaction at your hash did what you think. Cheap, and it catches a whole class of confusion.

### Idempotency — how a retry cannot double-send

Two mechanisms, and you want **both**. The insight: an Ethereum transaction is uniquely identified by
`(sender, nonce)`. **Two transactions with the same nonce can never both be mined.** That is a
hard consensus guarantee, and it is a much stronger foundation than any application-level dedupe.

**Mechanism A — sign first, persist the hash, broadcast last.**

The naive `writeContract()` is *not* safe: it picks a nonce, signs, and broadcasts in one opaque
step, and if your process dies after broadcast but before you write the row, you have an unrecorded
payment on-chain. Split it:

```
1. BEGIN; SELECT ... FOR UPDATE on the wallet row   -- serialise nonce allocation
2. reserve nonce N (from a DB counter, seeded/reconciled against eth_getTransactionCount)
3. build + SIGN the tx locally  -> serializedTransaction
4. hash = keccak256(serializedTransaction)          -- known BEFORE broadcast
5. INSERT payout_attempt (idempotency_key UNIQUE, nonce UNIQUE, tx_hash, state='pending'); COMMIT
6. sendRawTransaction({ serializedTransaction })     -- only now does it hit the network
7. waitForTransactionReceipt -> emit confirmed | failed
```

Steps 3–4 are the trick: **signing is deterministic and offline**, so you learn the hash before the
network ever hears about the transaction. The row exists before the money can move. Crash anywhere
after step 5 and the recovery path is unambiguous — the row tells you the hash, and you go ask the
chain what happened to it.

**Mechanism B — idempotency key with a unique index.**

`idempotency_key TEXT UNIQUE` on the attempts table. `sendUsdc({ to, amountCents, idempotencyKey })`
first does a lookup:
- **row exists, state `confirmed`/`failed`** → return the stored terminal result. Do not touch the chain.
- **row exists, state `pending`** → return the stored hash and re-enter the wait. Do not sign again.
- **no row** → run the flow above; the `UNIQUE` constraint is the actual race-winner if two
  concurrent lambdas arrive together (loser catches the constraint violation and re-reads the winner's row).

Also store a hash of `(to, amountCents)` against the key and **reject a reused key with different
parameters** — that's a caller bug, and silently sending the old amount hides it.

**Why both:** the idempotency key handles the *application* retry (client double-click, Vercel
function retry, queue redelivery). The nonce handles the *network* retry (re-broadcast of a stuck
transaction). If a pending transaction is stuck and you re-broadcast the **byte-identical signed
payload**, you get the identical hash — the node replies "already known", which is a no-op, not a
second payment. If you instead need to *speed it up*, you re-sign the **same nonce** with higher gas;
worst case one of the two mines, never both.

**Vercel-specific:** serverless means concurrent invocations with no shared memory, so an in-process
nonce counter is wrong. Nonce allocation **must** be serialised in Postgres — a `SELECT … FOR UPDATE`
on a single wallet row, or a `pg_advisory_xact_lock`. One server wallet, one nonce sequence, one lock.
Also note Vercel function timeouts: don't block a request handler on a 90 s wait. Broadcast, return
`pending` with the hash immediately, and confirm from a background poller / cron reconciler. That is
*also* the correct ACH-shaped design, so it costs nothing architecturally.

### Normalised rail events (same shape as ACH)

The whole point of "a rail is an adapter, not a schema": the USDC adapter must emit the same event
vocabulary an ACH adapter does, with rail-specific facts quarantined in a `metadata` blob.

| Ledger event | ACH meaning | USDC meaning |
|---|---|---|
| `payout.initiated` | file submitted to bank | signed + broadcast, hash known |
| `payout.pending` | in flight, awaiting settlement | in mempool / mined but < N confirmations |
| `payout.confirmed` | settled | receipt `success` at N confirmations |
| `payout.failed` | returned / rejected (R01…) | receipt `reverted`, or permanently dropped |

Rail-specific detail (`txHash`, `blockNumber`, `confirmations`, `gasUsed`, `effectiveGasPrice`,
`explorerUrl`) lives in `metadata` and never leaks into the ledger's core columns. The ledger should
be readable by someone who has never heard of Base.

---

## 6. Security — holding a testnet key

> **This key must never hold real funds. Not now, not later, not "just briefly".**
> Generate it fresh for this trial, fund it only from testnet faucets, and treat the address as
> permanently burned. If it ever touches mainnet, rotate it and never reuse it.

### Vercel

- Store as an **Environment Variable** in the Vercel project (Settings → Environment Variables),
  scoped to the environments that need it. **Do not** prefix with `NEXT_PUBLIC_` — that prefix inlines
  the value into the client bundle and would publish the key to every visitor. Name it so the mistake
  is loud: `BASE_SEPOLIA_PRIVATE_KEY`.
- Mark it **Sensitive** where Vercel offers that, so it becomes write-only in the dashboard and can't
  be read back by anyone with project access.
- Import it **only** in server-side modules — a route handler, a server action, or a `server-only`
  module. Add `import 'server-only'` at the top of the adapter file; that turns an accidental client
  import into a build error instead of a leak.
- Read it lazily inside the function, not at module top level, so a missing var fails with a clear
  message at request time rather than breaking the build in a confusing way.
- `.env.local` is gitignored by `create-next-app` by default — confirm that, and confirm the repo has
  no `.env` committed, before the first push.
- **Never log it.** No `console.log(process.env)`, no error handler that dumps config. Redact by
  construction: only ever log `account.address`.

### `.env.example`

Commit this; it documents the contract without leaking anything.

```dotenv
# ---- Base Sepolia USDC payout rail (TESTNET ONLY) --------------------------
# Chain: Base Sepolia (chainId 84532)

# Public RPC needs no API key. Override with a provider URL if you get rate-limited.
BASE_SEPOLIA_RPC_URL="https://sepolia.base.org"

# Circle's official USDC on Base Sepolia. 6 decimals. Verified on-chain.
# Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
USDC_BASE_SEPOLIA_ADDRESS="0x036CbD53842c5426634e7929541eC2318f3dCF7e"

# !!! TESTNET KEY ONLY — NEVER a key that holds or has ever held real funds. !!!
# 0x-prefixed, 64 hex chars. Generate a throwaway; fund only from faucets.
# Set in Vercel as a Sensitive env var. NEVER prefix with NEXT_PUBLIC_.
BASE_SEPOLIA_PRIVATE_KEY="0x0000000000000000000000000000000000000000000000000000000000000000"

# Blocks to wait before emitting payout.confirmed. 2 blocks ~= 4s on Base Sepolia.
USDC_CONFIRMATIONS="2"

# Hard ceiling per payout, in cents. Defence-in-depth against a bad amount.
USDC_MAX_PAYOUT_CENTS="100000"
```

### Other guardrails worth 10 minutes each

- **Assert the chain at startup.** `if (publicClient.chain.id !== 84532) throw`. A config slip that
  points the same key at mainnet should be impossible, not merely unlikely.
- **Cap the amount.** Reject `amountCents > USDC_MAX_PAYOUT_CENTS` in the adapter. Cheap, and it
  makes the "we thought about blast radius" point for free.
- **Validate the recipient.** `isAddress(to)`, and normalise with `getAddress(to)` (EIP-55 checksum)
  before it goes anywhere near the ledger. Reject the zero address explicitly.
- **Keep the hot wallet nearly empty.** It should hold only faucet funds. Nothing to steal is the
  best key management.

---

## 7. Managed alternatives — Circle / Bridge sandbox

**[UNCONFIRMED — secondary sources only, not verified by signing up]**

- **Circle** does run a self-serve sandbox: sign up at <https://console.circle.com/signup>, create a
  Standard API key in the sandbox console, and you get Programmable Wallets / Circle Mint style APIs
  against testnets. Circle also runs the public faucet we're already using. So the door is genuinely
  open without a sales call. But the surface you'd be adopting — developer-controlled wallets, wallet
  sets, entity secrets and their ciphertext rotation dance — is *more* setup than viem, not less, and
  it puts a vendor SDK between your ledger and the thing the brief actually asks you to demonstrate.
- **Bridge** (`https://api.sandbox.bridge.xyz/v0`) reportedly offers self-serve sandbox access with
  simulated chain confirmations and pre-funded test wallets. Attractive on paper for an ACH+stablecoin
  story. **[UNCONFIRMED]** whether API-key issuance is truly self-serve today or still gated behind a
  contact-sales step, and whether KYB is required. Given a 48-hour clock, "probably self-serve" is not
  a dependency you want on the critical path.

### Verdict: use raw viem.

The brief's phrasing is the whole answer — it wants a payout that **actually confirms on a testnet**,
and it frames a rail as **an adapter, not a schema**. Raw viem delivers exactly that with zero
signup, zero approval risk, zero cost, and a real transaction hash you can open on
sepolia.basescan.org in front of the reviewer. It is roughly 150 lines and one dependency, and every
one of those lines is *your* code demonstrating the thing being assessed: nonce discipline,
idempotency, integer money, and a normalised initiate → pending → confirmed event flow. A managed
sandbox would replace all of that reasoning with a vendor call and a simulated confirmation, which
demonstrates that you can read someone's API docs — a strictly weaker signal — while adding a
credential dependency that can block you at hour 3 with no recourse. The one thing a managed provider
buys that viem can't is the fiat leg (KYC/KYB, ACH in/out, off-ramp), and that is explicitly out of
scope for a testnet payout demo. Note the alternative in the write-up as a considered-and-rejected
trade-off — that's worth more than silently picking the same thing.

---

## Sources

- [Circle — USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Circle — Testnet Faucet](https://faucet.circle.com)
- [Circle — Developer Console signup](https://console.circle.com/signup)
- [Base — Connecting to Base](https://docs.base.org/base-chain/quickstart/connecting-to-base)
- [Base — Network faucets](https://docs.base.org/base-chain/network-information/network-faucets)
- [Coinbase Developer Platform — Faucets](https://www.coinbase.com/developer-platform/products/faucet)
- [viem — Installation](https://viem.sh/docs/installation)
- [viem — writeContract](https://viem.sh/docs/contract/writeContract)
- [viem — waitForTransactionReceipt](https://viem.sh/docs/actions/public/waitForTransactionReceipt)
- [viem — getTransactionConfirmations](https://viem.sh/docs/actions/public/getTransactionConfirmations)
- [viem releases](https://github.com/wevm/viem/releases)
- [Bridge API docs](https://apidocs.bridge.xyz/)
- Live RPC verification against `https://sepolia.base.org` performed 2026-09-09 (chain ID, USDC
  `decimals`/`symbol`/`name`/`version`, EIP-1967 proxy slot, 100-block time average).
