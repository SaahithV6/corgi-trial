# The USDC payout

**A stablecoin payout that actually confirms on a testnet is worth far more
than a slide about one.** This is that payout, and this document is what it
does, what it refuses to do, and the things it does not do at all.

Two providers move USDC over this rail: the direct-to-chain path, which signs
its own transactions, and Circle Web3 Services, which does not. The first half
of this document is the direct path. **The second provider starts at *The second
provider: Circle*, below**, and the reason it is here is that "a rail is an
adapter, not a schema" is a claim one provider cannot demonstrate.

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

---

# The second provider: Circle

A rail is an adapter, not a schema. That is a claim, and one provider cannot
demonstrate it. This is the second one.

**Nothing below the provider boundary changed to accommodate it.** Same
`postUsdcPayout`, same chart accounts, same cents, same dust rule, same value
date from the block's own timestamp, same idempotency key derived from the same
on-chain transaction hash. What changed was a slug on an outcome and two
failure modes a *mediated* provider can have that a self-signing one cannot.

## The transaction

Real, on the same public chain, sent by Circle's sandbox rather than by us.

| | |
|---|---|
| Circle transaction id | `a384de2e-ff91-5bc8-8c05-7f13112ba22b` |
| tx hash | [`0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa`](https://sepolia.basescan.org/tx/0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa) |
| network | Base Sepolia, chain id 84532 (`BASE-SEPOLIA`) |
| Circle wallet | `9a3524c0-728c-554f-8d26-a19c6ee66a4a`, EOA, developer-controlled |
| from | `0xeaa8ce10abcbce9d7f5257126c36a078c9951e1c` |
| to | `0x000000000000000000000000000000000000dEaD` |
| amount | 0.100000 USDC (`100000` minor units) |
| receipt status | `0x1` — **read off Base Sepolia by us, not reported by Circle** |
| block | 46,657,187 · `0x002ecb5e611d35fb0d8756d63d04af49da0c487f57b01732846d36e786f711fe` |
| block time | 2026-09-10T23:24:22Z |
| gas | 44,843 used @ 6,000,000 wei = 269,058,000,000 wei |

Wallet balance, read off the chain either side of the send:

```
circle wallet USDC   1.000000 USDC  ->  0.900000 USDC
```

And the journal entry it produced — note the provider slug in the description:

```
entry           9ad9fac3-b0e5-4d87-a5b0-55027ede22d5
value date      2026-09-10          (from the block timestamp, in book time)
rail            usdc
external_ref    0x251858a3…d476fa
idempotency_key usdc:payout:0x251858a3…d476fa
description     USDC payout 0.100000 USDC to 0x…dead (circle sandbox payout)
                — circle.w3s block 46657187, gas 269058000000 wei

DR 2100/e274546d…   10   Ridgeline Robotics, Inc. — business current account
CR 1140             10   USDC omnibus wallet — Base Sepolia
   balance           0

1140 before  1950 cents      1140 after  1940 cents
```

Running the posting a second time returns the same entry id and writes nothing:
`entries with this key: 1`. That is the UNIQUE constraint on
`journal_entry.idempotency_key`, and it is the reason **the same payout cannot be
booked twice by two providers** — the key is derived from the on-chain hash, and
both rails produce the identical string for the identical movement.

## Which base URL, and how we know

Measured, with the real key. The first three lines are the ones that matter:

```
GET  https://api.circle.com/v1/w3s/config/entity/publicKey        -> 200  (RSA PEM)
GET  https://api.circle.com/v1/w3s/wallets                        -> 200
GET  https://api.circle.com/v1/w3s/walletSets                     -> 200  {"walletSets":[]}
GET  https://api.circle.com/v1/configuration                      -> 403
POST https://api.circle.com/v1/faucet/drips                       -> 403  {"code":3,"message":"Forbidden"}

GET  https://api-sandbox.circle.com/ping                          -> 200  {"message":"pong"}
GET  https://api-sandbox.circle.com/v1/w3s/config/entity/publicKey -> 401 "Invalid credentials."
GET  https://api-sandbox.circle.com/v1/w3s/wallets                -> 401
```

**Web3 Services has one host and the key's prefix selects the environment.**
`api-sandbox.circle.com` is Circle *Mint*, a different product this key is not
entitled to, which is also why `/v1/configuration` answers 403 rather than 200.
That 403 is evidence of what the credential is scoped to, not a failure.

`src/lib/rails/stablecoin/circle-config.ts` therefore **refuses any key that does
not begin `TEST_API_KEY:`**. There is no sandbox hostname to hide behind, so the
testnet guarantee has to be enforced on the credential itself — and "live-mode
API keys" is an automatic fail on this trial.

## The shape that makes Circle dangerous

The direct path knows its transaction hash **before** the money can move: the
hash is `keccak256` of bytes we signed. Circle inverts that.

```
POST /v1/w3s/developer/transactions/transfer
  -> 201 {"data":{"id":"a384de2e-…","state":"INITIATED"}}
```

No hash. No chain. Nothing to look up. An acknowledgement that arrives in the
same call as the request, carries an id you can log, and means **nothing** about
whether money moved.

`types.ts` already said there is no `submitted` outcome the ledger will accept,
and DECISIONS 011 and 030 already said a payout is posted on a CONFIRMED
receipt and never on an acknowledgement. `INITIATED` is precisely the
acknowledgement those rules were written about, and it now has a provider that
produces one.

**How `INITIATED` is stopped, in three layers.** Not by a convention anyone has
to remember:

1. **It is not a payable value.** `PayoutOutcome` gained one member,
   `acknowledged`, whose `txHash` is `null` — not optional, `null`, so it cannot
   be read without being seen. `ConfirmedPayout` is still
   `Extract<PayoutOutcome, {kind:"confirmed"}>` and `postUsdcPayout` still takes
   only that. Passing an `acknowledged` outcome to the ledger is a **compile
   error**.
2. **There is no branch that turns a Circle state into `confirmed`.** The only
   constructor of `confirmed` in this package is `settleTransaction`, which
   reads a receipt off a node, asserts `status: 0x1`, and re-checks the block is
   canonical. Circle reaches the ledger through it or not at all.
3. **A test that would fail if either of those slipped.**
   `circle-provider.test.ts` scripts a Circle that says `INITIATED` forever and
   asserts `isConfirmed(outcome) === false` — and separately asserts the adapter
   made **zero** `eth_getTransactionReceipt` calls, because there was no hash to
   ask about.

## And then we do not believe the receipt either

A receipt with `status: 0x1` proves *some* transaction succeeded. For the direct
path that is enough — we built its calldata. For Circle it is not: **Circle built
the calldata and then told us a hash.**

So after the receipt, `verifyTransferOnChain` pulls the ERC-20 `Transfer` logs
for that exact hash, in the block the receipt named, and requires one from our
wallet, to our recipient, for our exact minor units:

```
verified against Base Sepolia ourselves —
  Transfer log in block 46657187 matches: 0.100000 USDC to 0x…dead
```

A mismatch is a new outcome, `unverified`, which carries the hash and posts
nothing. Three tests drive it: no matching log at all, a log for a different
amount, and a matching log belonging to a different transaction in the same
block.

This is the trial's own non-negotiable applied where it actually bites — *"your
payment provider's balance is their ledger, not yours"*. Circle's async shape is
exactly what tempts an implementation to take the provider's word, because the
provider's word arrives first and looks authoritative.

The same rule runs the other way, and there is a test for that too: **a transfer
Circle calls `FAILED` that the chain shows as a confirmed transfer of our exact
amount to our exact recipient IS a payout.** The money is gone whatever Circle's
row says, and refusing to post it would leave a real movement unrecorded.

## What we polled for, and the measurement that changed it

The first implementation waited for a terminal state — `COMPLETE`, `FAILED`,
`CANCELLED`, `DENIED` — because that is what the documentation points at. Then
the live transfer ran:

```
t+0s     INITIATED   no txHash              (the acknowledgement)
t+~10s   CONFIRMED   txHash 0x251858a3…     (the money has already moved)
t+181s   CONFIRMED   txHash 0x251858a3…     (still not COMPLETE)
```

The USDC left the wallet at roughly ten seconds — 1.000000 → 0.900000, read off
the chain — and Circle was still not saying `COMPLETE` three minutes later. The
first run therefore timed out and returned `unconfirmed`, correctly posting
nothing.

**`COMPLETE` is Circle's own finality bookkeeping.** Waiting for it is waiting
for the provider's opinion about a fact the chain has already settled, which is
the one thing this rail exists not to do. So the loop now stops on either
condition and reports which:

```
a hash appeared   -> stop, and go ask Base Sepolia what it says
Circle is done    -> stop. With no hash, nothing reached a chain at all
```

That is **stricter** than waiting for `COMPLETE`, not looser: `COMPLETE` would
be Circle's word for success; a receipt with `status: 0x1` plus a matching
`Transfer` log is ours. `isTerminal()` is still consulted — "Circle stopped
without ever producing a hash" is a real and different ending, and it is
`refused: provider_declined`.

## The entity secret

Circle authorises a developer-controlled wallet action with an
`entitySecretCiphertext`: the 32-byte entity secret, RSA-OAEP-SHA256 encrypted
against the entity public key from `GET /v1/w3s/config/entity/publicKey`. Circle
**rejects a reused ciphertext**, which is a good design — a replayed ciphertext
is a replayed authorisation — so it cannot be computed once and cached.

`CircleClient.encryptEntitySecret()` is called inside every mutating method.
OAEP seeds randomly, so the same secret produces a different ciphertext each
time; `circle-client.test.ts` generates a real RSA key pair, decrypts the
ciphertext back to the entity secret to prove the encryption is exercised rather
than mocked, and asserts three successive encryptions are three distinct
strings. The **public** key is cached, because it is a public key.

**Where the secret lives, stated plainly.** In `.env`, which is gitignored and
has never been committed. Circle's own console warns *"Never expose your Entity
Secret in source control, configuration files, or logs"*, and `.env` is a
configuration file. This is a work-trial testnet credential in a local dotfile,
not a secrets manager, and saying so is better than implying otherwise. It is
never logged: `describeCircleConfig()` exists so operator output can describe
the configuration without printing any of it, and a test asserts the description
contains neither the key nor the secret.

## Selection is explicit and visible

```
STABLECOIN_PROVIDER unset      -> base.usdc    the direct-to-chain rail
STABLECOIN_PROVIDER=circle     -> circle.w3s
STABLECOIN_PROVIDER=circl      -> base.usdc    a typo is not a provider
```

Never inferred from which credentials happen to be present. And asking for
Circle when Circle is not configured **does not quietly get you the direct
path** — it gets a provider that reports `not_configured` and refuses with
`provider_not_configured`. A silent fallback would move real testnet money over
a rail nobody chose and then write that rail's name into an append-only ledger,
where it cannot be corrected by editing.

A reader never has to guess which rail moved the money:

| surface | how |
|---|---|
| journal entry | `— circle.w3s block 46657187, gas … wei` in the description |
| the outcome | `outcome.provider` |
| health | `stablecoinProviderHealth()` returns one row per rail, each with a label |
| operator output | `describeSelection()` — `circle.w3s — Circle Web3 Services, Base Sepolia (…)` |

`postUsdcPayout` writes `outcome.provider` rather than the old `USDC_PROVIDER`
constant. That one line is the entire ledger-side change.

## Health, in the DECISIONS 011 vocabulary

```
live            an authenticated round trip returned 2xx AND a wallet exists
unauthorised    the credential was rejected (401/403), or works but cannot pay
unreachable     network failure — status 0. We do not know.
not_configured  no key at all
```

`unreachable` and `unauthorised` are kept apart because they need different
human responses: one is a wrong key, the other is a bad afternoon. A credential
that authenticates but has no `BASE-SEPOLIA` wallet is **not** `live` — it is a
rail that cannot move money, and reporting live there claims a capability we do
not have. That case was real: the first health probe against the new account
returned exactly it, before the wallet was provisioned.

```
health base.usdc   live           0xd3629d…2918 on chain 84532, 99724160442266 wei of gas
health circle.w3s  unauthorised   credential works but no sending wallet: no BASE-SEPOLIA
                                  wallet exists on this Circle account
```

## How the wallet was funded, and why it is not in the ledger

Circle's testnet faucet is not entitled on this key (`POST /v1/faucet/drips` →
403), so the wallet was funded from our own treasury wallet:

```
gas   0x8b907a16e40c680ea68229cdcc497a919d2886c4940660b22284d61c542d15b6   30,000,000,000,000 wei
USDC  0xf7e3d2fe42a59ec8a8562a42406fd9aef2755bc8873d207f45ba12a56b095cfc   1.000000 USDC
```

**Neither is a journal entry, deliberately.** Both wallets are ours, and 1140 is
a single omnibus asset account covering our USDC holdings — moving tokens
between two of our own wallets does not change it. A correct entry would be
`DR 1140 / CR 1140` for the same amount, which nets to zero and would be
rejected as a zero-amount line. Posting it as a payout would be worse: it would
book a customer's deposit against a treasury transfer that no customer made.

**A real thing this exposed.** The USDC funding transfer came back `reorged`:

```
kind    REORGED
detail  receipt claims block …, chain now has …
```

The transfer had in fact succeeded — status `0x1`, and the Circle wallet held
1.000000 USDC a moment later. `https://sepolia.base.org` is load-balanced, and
the block-hash re-read immediately after the receipt can land on a node that has
not yet seen that block. The adapter refused to post, which is the **safe**
direction of that failure: it under-claims rather than over-claims, and the
transfer is recoverable from the hash. It is a false positive on a public RPC
endpoint, not a reorg, and the fix is a node with a consistent view rather than
a weaker check.

## What the Circle rail does not do

Stated rather than discovered. In addition to the six gaps above, which all
still apply:

7. **1140 does not reconcile to the Circle wallet either.** After the payout the
   chain says the wallet holds 0.900000 USDC and the ledger's 1140 contribution
   from this rail is −$0.10. `circle-recon.ts` computes exactly that break and
   reports it rather than hiding it:

   ```
   1140 BREAK on 0xeaa8ce10…1e1c: chain 90 cents, ledger 0 cents
     — 90 cents on chain with no journal entry
   ```

   The 90 cents is the un-booked funding transfer above and nothing else. The
   function takes `openingUnbookedCents` so a caller can net it out explicitly
   and get `reconciled: true` with the reason written down, instead of a number
   that looks like a mystery. It is **pure** — no database, no network — and it
   diffs against `eth_call balanceOf`, never against Circle's
   `/v1/w3s/wallets/{id}/balances`. That endpoint is called exactly once, to
   resolve Circle's uuid for the USDC contract, and never as a source of truth.

8. **The health surface is not wired into `/api/health`.** `stablecoinProviderHealth()`
   returns a row per rail in the same four-word vocabulary
   `src/lib/integrations/probe.ts` uses, and it is not called from there — that
   module was out of scope for this change. It is a one-function call away, and
   until it happens the endpoint reports the stablecoin slot without naming
   which of the two providers is selected.

9. **The wallet id is discovered, not pinned.** `CIRCLE_WALLET_ID` is optional;
   absent, the provider accepts exactly one `BASE-SEPOLIA` wallet and errors on
   zero or several rather than picking "the first" — which account paid should
   not depend on a provider's list ordering. Setting it is one line of `.env`
   and removes a round trip.

10. **No approval gate, same as the direct path.** 0.10 USDC is far below the
    $1,000 USDC approval threshold, so this path does not create a
    `payment_instruction`. A production payout of size goes through
    `src/lib/approvals/` first and this adapter second — and that is unchanged
    by there now being two adapters, which is the point.

## Files

```
src/lib/rails/stablecoin/
  circle-config.ts     credentials; not_configured, and a live key is refused
  circle-types.ts      Circle's wire shapes, the state machine, decimal <-> bigint
  circle-client.ts     the API over fetch; entity secret encrypted per request
  circle-provider.ts   instruct -> poll -> VERIFY ON CHAIN -> outcome
  circle-registry.ts   both providers behind one interface; explicit selection
  circle-recon.ts      1140 against the chain, never against Circle's balance
  circle-*.test.ts     81 tests, none of them touching a network
```
