# The USDC payout

**A stablecoin payout that actually confirms on a testnet is worth far more
than a slide about one.** This is that payout, and this document is what it
does, what it refuses to do, and the four things it does not do at all.

## The transaction

Real, on a public chain, verifiable by anyone reading this.

| | |
|---|---|
| tx hash | [`0xb47c5a368f79786f73947c4f1980615557ff1800cd92818bd33070f7ed7986a1`](https://sepolia.basescan.org/tx/0xb47c5a368f79786f73947c4f1980615557ff1800cd92818bd33070f7ed7986a1) |
| network | Base Sepolia, chain id 84532 |
| token | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle USDC) |
| from | `0xd3629d7399945A1Ff2C5a1c5b0F7C9d32D3c2918` |
| to | `0x000000000000000000000000000000000000dEaD` |
| amount | 0.500000 USDC (`500000` minor units) |
| nonce | 0 — this wallet's first transaction ever |
| receipt status | `0x1` |
| block | 46,651,201 · `0x3f4b183645d70c66172afea111e61f12e83459ed032a197db9bdafb9ec539af0` |
| block time | 2026-09-10T20:04:50Z |
| gas | 44,843 used @ 6,000,000 wei = 269,058,000,000 wei |

Balances read off the chain either side of the send, not inferred:

```
sender USDC       20.000000 USDC  ->  19.500000 USDC
sender gas     100000000000000 wei -> 99724160442266 wei
recipient USDC  6142.438501 USDC  ->  6142.938501 USDC
```

And the journal entry it produced:

```
entry           9ab676c5-6c84-4124-bede-d2b9facf8558
value date      2026-09-10          (from the block timestamp, in book time)
rail            usdc
external_ref    0xb47c5a36…86a1
idempotency_key usdc:payout:0xb47c5a36…86a1
actor           ledger-poster

DR 2100/e274546d…    50   Ridgeline Robotics, Inc. — business current account
CR 1140              50   USDC omnibus wallet — Base Sepolia
   balance             0
```

Running `node scripts/payout-usdc.mjs` a second time sends nothing, posts
nothing, and prints the same entry id. See *Idempotency*, below.

## How to run it

```bash
set -a; . ./.env; set +a

node scripts/payout-usdc.mjs                    # the payout, end to end
node scripts/payout-usdc.mjs --check            # read the chain, send nothing
node scripts/payout-usdc.mjs --amount 0.25 --to 0x…
node scripts/payout-usdc.mjs --settle 0x<hash>  # post a transfer already sent
node scripts/payout-usdc.mjs --allow-duplicate  # deliberately send a second one
```

The default recipient is a burn address, and that is a deliberate trade, not an
oversight: on a testnet, with 20 USDC and a faucet behind it, a destination that
needs no key management is worth more than 0.50 USDC of recoverable balance.
Override it with `USDC_PAYOUT_RECIPIENT` or `--to` for any address you control.

## No dependency was added

There is no `viem` and no `ethers` in this repo, and putting one into the
deployed application so that a payout script can sign a transaction is a bad
trade — the same argument `scripts/faucet.mjs` makes about the CDP SDK. So the
four primitives are in `src/lib/rails/stablecoin/`:

| file | what it is |
|---|---|
| `keccak.ts` | Keccak-256. **Not** `createHash("sha3-256")`: FIPS-202 pads with `0x06`, Ethereum's pre-standard Keccak pads with `0x01`, and node's OpenSSL has no `keccak256` at all. |
| `secp256k1.ts` | Point arithmetic, address derivation, RFC 6979 deterministic ECDSA with a recovery bit and EIP-2 low-`s` normalisation. |
| `rlp.ts` / `tx.ts` | RLP, and the EIP-1559 typed envelope. |
| `client.ts` | Thirteen JSON-RPC methods over `fetch`, every quantity a `bigint`. |

None of it was trusted until it was checked. `keccak.test.ts` and `tx.test.ts`
pin it to published vectors — the empty-string digest, the empty-trie root, the
three inputs either side of the 136-byte rate boundary, and the **EIP-155
example transaction**, whose exact published `r` and `s` come back out. Because
the signature is deterministic, reproducing both of those numbers is only
possible if the address derivation, the RLP, the hash and the signer are all
simultaneously right.

`tx.test.ts` then does the strongest available check: it takes the fields and
signature of the transaction above, read back off Base Sepolia with
`eth_getTransactionByHash`, feeds them through the encoder, and asserts the
hash that comes out is the hash the network has. No private key is involved.

## The hash is known before broadcast, and that is the whole design

An Ethereum transaction hash is `keccak256` of the signed transaction's own
bytes. Nothing about it is assigned by the network. So the identifier for this
money movement exists on our machine *before* a byte goes over the wire, and
`scripts/payout-usdc.mjs` prints it there:

```
  signed locally
  tx hash               0xb47c5a36…86a1   <- known BEFORE broadcast
  idempotency key       usdc:payout:0xb47c5a36…86a1
  broadcasting ...
```

That key goes to `postEntry()`, and `journal_entry.idempotency_key` is UNIQUE,
so a second posting of the same transfer is a no-op decided by Postgres.

The alternative — broadcast, then ask the node what it called the transaction —
has a window in which money has moved under a name we do not yet know. That
window is where double spends live.

## The three crash points

A payout is two writes to two systems that cannot share a transaction. There
are exactly three places the process can die, and each one has a stated answer.

### 1. Before broadcast

Nothing was signed onto the wire. No money moved, nothing posted. A re-run
reads the same nonce (nothing is pending), builds a transaction, and sends
exactly one. Safe by construction.

### 2. After broadcast, before the receipt

A transaction is in the mempool at nonce *N* and we never learned its fate.
**This is the window that produces double sends**, because the naive re-run
reads `eth_getTransactionCount(pending)` — which already counts the in-flight
transaction — builds a *second* transfer at nonce *N+1*, and pays twice.

Closed by reading `pending` and `latest` separately and **refusing while they
disagree**:

```
kind    REFUSED
reason  transaction_in_flight
detail  nonce pending=1 latest=0: 1 transaction(s) from this wallet are
        unmined. Broadcasting now would take nonce 1 and send a SECOND payout.
        Wait for the mempool to clear, then re-run.
```

Once the pending transaction mines, point 3 finds it. If it is dropped instead,
`pending` falls back to `latest` and the re-run sends exactly one transfer. The
hash was also printed before the broadcast, so `--settle <hash>` resumes
directly.

### 3. After the receipt, before the ledger write

The money has moved and nothing records it. Closed by asking **the chain**, not
a local row: before building anything, the adapter runs `eth_getLogs` for an
ERC-20 `Transfer` from this wallet, to this recipient, for this amount, over the
last 10,000 blocks. If it finds one, it returns that transaction's receipt as a
`confirmed` outcome with `recovered: true`, having sent nothing, and the caller
posts under the same idempotency key.

That is also what makes the second run of the demo a clean no-op:

```
── payout ──
  already on chain as 0xb47c5a36…86a1 — sending nothing, settling that one
── outcome ──
  kind       CONFIRMED
  recovered  yes — found on chain, nothing was sent this run
── chain, after ──
  sender USDC   19.500000 USDC  ->  19.500000 USDC
── ledger ──
  entry id      9ab676c5-6c84-4124-bede-d2b9facf8558      (the same entry)
  entries with this key 1
```

**The honest limit of point 3.** The on-chain evidence is
`(token, from, to, amount)`, so two payouts agreeing on all four are
indistinguishable to the scan, and it reaches back 10,000 blocks and no
further. A production system carries a durable intent id, and the natural home
for it is a `usdc_payout` table that this build does not have — see *What this
does not do*.

## Nothing is assumed

Every input is read from the chain on the run that uses it.

| | |
|---|---|
| nonce | `eth_getTransactionCount(pending)`, cross-checked against `latest` |
| base fee | `eth_getBlockByNumber("pending")`, falling back to `eth_gasPrice` |
| priority fee | `eth_maxPriorityFeePerGas`, falling back to `eth_gasPrice` |
| gas limit | `eth_estimateGas` × 1.25 |
| chain id | `BASE_SEPOLIA_CHAIN_ID`, re-checked against `eth_chainId` |

`maxFeePerGas` is 3× the base fee plus the tip. EIP-1559 refunds the
difference, so overshooting costs nothing while undershooting produces a
transaction that sits in the mempool forever — which is crash window 2 with no
crash.

## Failure is a first-class outcome

`sendUsdcPayout` returns a `PayoutOutcome`; it does not throw for anything a
chain can legitimately do to a transaction, and **every non-refusal outcome
carries the transaction hash**. An exception that unwinds the stack with the
hash inside it is how a payout becomes unfindable.

| outcome | what happened | posts? |
|---|---|---|
| `confirmed` | receipt read back, `status: 0x1`, block still canonical | yes |
| `reverted` | mined and failed, `status: 0x0`. Gas gone, no USDC moved | no |
| `reorged` | the block carrying it stopped being canonical | no |
| `unconfirmed` | still in the mempool when the timeout expired | no |
| `dropped` | the node stopped knowing about it | no |
| `refused` | nothing was signed onto the wire | no |

The refusals, each one checked before anything costs anything:

| reason | |
|---|---|
| `sender_key_mismatch` | the key does not derive the configured address |
| `chain_id_mismatch` | the node is not on the configured network |
| `insufficient_usdc` | the wallet does not hold the tokens |
| `transaction_in_flight` | crash window 2 — see above |
| `estimate_reverted` | `eth_estimateGas` refused; the transfer would burn gas and move nothing |
| `insufficient_gas` | the wallet cannot cover `gasLimit × maxFeePerGas`, the *worst* case being authorised |
| `broadcast_rejected` | signed, and the node refused the bytes. Carries the hash |

Only `confirmed` can reach the ledger, and the type system enforces it:
`postUsdcPayout` takes a `ConfirmedPayout`, which is only constructible after a
receipt has been read and `status: 0x1` asserted. "We posted a payment that
never happened" is a compile error, not a code review.

There is one deliberate `throw`: if the node returns a hash different from the
one computed locally. That cannot happen unless the keccak or the RLP is wrong,
and if it does, the idempotency key names a transaction that does not exist.

## The ledger posting

```
DR 2100/<business>   the customer's deposit account   — credit-normal, so
                     money leaving the customer is a DEBIT
CR 1140              USDC omnibus wallet — Base Sepolia
CR 2900              rounding residual, only when there is sub-cent dust
```

Value date is the **block's own timestamp**, converted to book time
(America/New_York) — not `Date.now()`, and not when the receipt was read. A
process restarted tomorrow that recovers yesterday's transfer still posts it on
yesterday. A block at 02:00 UTC belongs to the previous New York business day,
and `ledger.test.ts` pins that case.

Everything goes through `postEntry()`. Nothing in this package writes to
`journal_entry` or `journal_line`.

### Why the ledger is in cents and not in USDC

`journal_line.currency` is `char(3)` and every seeded account is `'USD'`, and
`assert_entry_balanced()` requires **each currency in an entry to net to zero
independently**. So an entry whose debit is USD and whose credit is USDC cannot
balance, by construction, without an FX bridge account pair that this chart does
not have. Widening the column would not fix that; it would just move the
problem.

Chart account 1140 already anticipated this and states its own unit: *"carried
in cents at 1 USDC = 100 cents … with sub-cent dust going to 2900 rather than
being truncated."* That is the convention followed here, and it is the reason
no migration 0012 was written.

The application still keeps the two apart where they could actually be added
together by accident: `src/lib/rails/types.ts` gives USDC its own `Currency`
code, and the `Money` that crosses the rail boundary is
`{ amount: 500000n, currency: 'USDC' }`. The narrowing to cents happens once,
visibly, at the posting boundary.

USDC has six decimals, so 1.234567 USDC is 123.4567 cents. Those four digits go
somewhere:

```
DR 2100/<business>   124    the customer parts with the rounded-UP cent
CR 1140              123    the wallet's whole cents
CR 2900                1    the difference, as a real, ageable balance
```

0.50 USDC has no dust and produces two lines. `ledger.test.ts` proves the
three-line case balances against the live database, and proves it balances for
every remainder in a cent.

## What this does not do

Stated rather than discovered.

1. **Gas is not posted.** Chart account 5300 ("Blockchain gas — USDC
   transfers") is the right home for it and is deliberately left empty. Gas is
   paid in ETH; the chart has no ETH-denominated asset account to credit, and
   converting wei to cents needs an ETH/USD rate this system has no live source
   for. Inventing one would be worse than the gap. On Base Sepolia the figure is
   small — 269,058,000,000 wei is 2.7×10⁻⁷ ETH, on the order of a tenth of a
   cent, so it rounds to zero cents and would be rejected as a zero-amount
   line — but on mainnet the accumulated figure is real. The actual
   `gasCostWei` is carried on the outcome and written into the entry
   description, so nothing is lost, only unposted.

2. **1140 does not reconcile to the wallet.** The ledger says 1140 is −$0.50;
   the chain says the wallet holds 19.50 USDC. The difference is the opening
   20 USDC, which arrived from the Circle faucet and never entered the books.
   Booking it needs an equity-contribution account the chart does not have, and
   inventing one under time pressure against money rows is the wrong trade. The
   gap is exactly the un-booked opening balance and nothing else.

3. **There is no durable intent table.** Crash windows 2 and 3 are closed by
   reading the chain, which is correct for one payout instruction at a time and
   bounded by the 10,000-block log scan. A `usdc_payout` row written before the
   broadcast — reference, signed bytes, hash, state — would close them without
   either caveat. It is the one thing a second day would buy here.

4. **The signer is not constant-time and is not a KMS.** `pointMul` is plain
   double-and-add and says so in its own comment. This is an operator script
   against a testnet key that has never touched real funds; a production signer
   belongs in a KMS or an HSM, not in application code, and pretending otherwise
   would be a worse lie than the timing leak.

5. **No approval gate.** The USDC approval policy requires an approver from
   $1,000 (lower than ACH, because an on-chain transfer is irreversible the
   moment it confirms and there is no recall window). 0.50 USDC is far below
   it, so this path does not create a `payment_instruction` and does not
   exercise `src/lib/approvals/`. A production payout of size would go through
   that gate first and this adapter second.

6. **One confirmation.** The demo waits for one, which is what the seeded rail
   semantics say for the testnet (`usdc.transfer.confirmed`: "1 on the testnet
   demo, 2 for anything real"). The reorg check is a real block-hash re-read
   both before and after the depth wait, but one confirmation on a testnet is a
   thin guarantee and is configurable rather than hidden.

## Files

```
src/lib/rails/stablecoin/
  keccak.ts       keccak256, hand-rolled, vector-checked
  secp256k1.ts    curve arithmetic, RFC 6979 signing, address derivation
  rlp.ts          RLP
  hex.ts          the bigint boundary for JSON-RPC quantities
  tx.ts           EIP-1559 envelope; the hash, before broadcast
  client.ts       thirteen JSON-RPC methods over fetch
  adapter.ts      refuse / sign / broadcast / wait / state an outcome
  allocation.ts   minor units -> balanced cents; block timestamp -> value date
  ledger.ts       the posting, through postEntry(), keyed on the tx hash
  types.ts        the outcome union
  *.test.ts       42 tests, 2 of them against the live database
scripts/payout-usdc.mjs
```
