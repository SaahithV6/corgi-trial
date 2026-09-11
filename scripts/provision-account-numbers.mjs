#!/usr/bin/env node
/**
 * Give every business its own virtual account number, and record whose it is.
 *
 * ─── THE FACT THIS SCRIPT CREATES ───────────────────────────────────────────
 *
 * Before this ran, `GET /account_numbers` on the Increase sandbox returned
 * EXACTLY ONE object — `sandbox_account_number_96mzhz3n61f5p0jpvytc`, routing
 * 123308582 / account 7467448488, named "primary", on the programme's own FBO
 * account — and all six businesses on the book shared it. An inbound ACH credit
 * names `account_number_id`, so the field that is supposed to say whose money
 * it is named the programme. Every inbound credit and every inbound wire
 * therefore parked as unattributable, correctly, because this build refuses to
 * guess whose money to move.
 *
 * `POST /account_numbers` issues another number on the same account, with its
 * own digits and its own id, and inbound payments addressed to it arrive naming
 * THAT id. So the provider will tell us which number was addressed. It will
 * never tell us whose number it is: that is ours to record, it is a FACT and
 * not a derivation, and `virtual_account_number` (db/migrations/0042) is where
 * it lives.
 *
 * ─── WHY THE ORDER IS PROVIDER FIRST, TABLE SECOND ──────────────────────────
 *
 * A row in `virtual_account_number` naming a number that does not exist at the
 * provider is a promise this book cannot keep: a customer would be given digits
 * that reject. A number at the provider with no row here is merely unused — an
 * inbound credit to it parks with the same refusal as before, which is exactly
 * the behaviour that was already correct. So the failure mode of "provider
 * first" is harmless and the failure mode of "table first" is not.
 *
 * The crash in between is handled by the provider, not by us:
 * `Idempotency-Key: corgi:vacct:<business id>` means a re-run cannot issue a
 * second number for the same business. MEASURED, and not the way this header
 * first guessed — Increase answers the repeat with `409
 * idempotency_key_already_used_error` naming the object it already created,
 * rather than replaying it. `issueAccountNumber()` below carries the measurement
 * and the one-line recovery. That is what makes this script safe to run twice,
 * and the reason it does not need a lock, a state column or a two-phase write.
 *
 * ─── INBOUND DEBITS ARE BLOCKED ON EVERY NUMBER IT ISSUES ───────────────────
 *
 * An account number accepts inbound ACH DEBITS by default
 * (`inbound_ach.debit_status: "allowed"`), which lets anyone holding the digits
 * PULL money out. This build does not model an inbound ACH debit at all — the
 * consumer parks one under `increase_debit_pull` — and handing a customer a
 * number that can be drained over a rail we cannot book would be a hole, not a
 * feature. Every number is created with `debit_status: "blocked"`, and a number
 * found unblocked is PATCHed and reported.
 *
 * ─── WHO GETS ONE ───────────────────────────────────────────────────────────
 *
 * Every business with an open `2100` deposit leaf. A business without one has
 * nowhere for the money to land, so a number issued to it could only ever
 * produce a credit that refuses to post — the refusal would just move from
 * "whose is this?" to "where does it go?". That is reported, not papered over.
 *
 * ─── WHAT IT IS NOT ALLOWED TO DO ───────────────────────────────────────────
 *
 * It never maps the programme's own "primary" number to a business. That number
 * is the FBO account's own, it is the one every historical inbound payment on
 * this book was addressed to, and mapping it would attribute five historical
 * inbound ACH deliveries and twenty-three inbound wires to whichever business
 * we picked. Those payments were addressed to the programme and the honest
 * answer is that they cannot be attributed. Attributing them by decree is the
 * exact failure this whole change exists to make unnecessary.
 *
 * Usage:
 *
 *   node scripts/provision-account-numbers.mjs            # dry run, writes nothing
 *   node scripts/provision-account-numbers.mjs --apply    # issue and record
 *   node scripts/provision-account-numbers.mjs --list     # report only
 */
import postgres from "postgres";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const APPLY = has("--apply");
const LIST_ONLY = has("--list");

const PROVIDER = "increase";
const BASE_URL = (process.env.INCREASE_BASE_URL ?? "https://sandbox.increase.com").replace(/\/+$/, "");
const API_KEY = process.env.INCREASE_API_KEY;

// The OWNER connection, deliberately. `corgi_app` is granted SELECT on
// `virtual_account_number` and nothing else (0042 §6): the webhook consumer
// that reads this table to decide whose money arrived must not be able to
// decide the answer. Issuing a number is an operator action.
const DB_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!API_KEY) {
  console.error("INCREASE_API_KEY is not set. Run: set -a; . ./.env; set +a");
  process.exit(1);
}
if (!DB_URL) {
  console.error("DIRECT_URL / DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });

async function increase(method, path, body, idempotencyKey) {
  const headers = { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    let problem = {};
    try {
      problem = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
    const err = new Error(`Increase ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.type = problem.type;
    err.resourceId = problem.resource_id;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * Issue one account number, idempotently — and the idempotency is NOT the one
 * the header first assumed.
 *
 * MEASURED, 2026-09-11, by running this script twice: a repeat
 * `POST /account_numbers` carrying an `Idempotency-Key` that has already been
 * used does NOT return the object again. It answers
 *
 *   409  {"type":"idempotency_key_already_used_error",
 *         "title":"The idempotency key submitted has already been used. Fetch
 *                  the created object or use a different idempotency key.",
 *         "resource_id":"sandbox_account_number_bh5spt0xmebnj6xq6t3l"}
 *
 * which is a stronger guarantee than a replay, not a weaker one: the provider
 * refuses to issue a second number for a key and NAMES the one it already
 * issued. So the recovery is exactly what the title says — fetch it — and the
 * "provider first, table second" order still repairs itself on a re-run.
 *
 * This is why the key is derived from the BUSINESS ID and not from the clock or
 * a run id. A key that changes between runs would make the 409 unreachable and
 * every crashed run would leave an orphan account number at the provider.
 */
async function issueAccountNumber(business, accountId) {
  const idempotencyKey = `corgi:vacct:${business.id}`;
  try {
    return {
      number: await increase(
        "POST",
        "/account_numbers",
        {
          account_id: accountId,
          name: business.legal_name,
          // See the header: a number a stranger can pull money out of, over a
          // rail this build does not book, is a hole.
          inbound_ach: { debit_status: "blocked" },
        },
        idempotencyKey,
      ),
      fresh: true,
    };
  } catch (e) {
    if (e.status !== 409 || e.type !== "idempotency_key_already_used_error" || !e.resourceId) throw e;
    return { number: await increase("GET", `/account_numbers/${e.resourceId}`), fresh: false };
  }
}

/** Every account number that exists at the provider, whoever it belongs to. */
async function listAccountNumbers() {
  const out = [];
  let cursor = null;
  do {
    const page = await increase(
      "GET",
      `/account_numbers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    out.push(...page.data);
    cursor = page.next_cursor ?? null;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------------------
// The population
// ---------------------------------------------------------------------------

const businesses = await sql`
  SELECT b.id,
         b.legal_name,
         (d.id IS NOT NULL) AS has_deposit_account,
         v.provider_account_number_id,
         v.routing_number,
         v.account_number
    FROM business b
    LEFT JOIN account d
           ON d.business_id = b.id AND d.code = '2100' AND d.closed_at IS NULL
    LEFT JOIN virtual_account_number v
           ON v.business_id = b.id AND v.provider = ${PROVIDER}
   ORDER BY b.created_at`;

const atProvider = await listAccountNumbers();
const byId = new Map(atProvider.map((n) => [n.id, n]));

/**
 * The Increase account every virtual number hangs off — the FBO account.
 *
 * Read from the provider rather than assumed, and REFUSED if it is ambiguous.
 * A programme with two accounts and no `INCREASE_ACCOUNT_ID` is a programme
 * where "the account" is a guess, and a guess about which pot a customer's
 * number sits on is not one this script gets to make quietly.
 */
async function resolveFboAccountId() {
  const explicit = process.env.INCREASE_ACCOUNT_ID;
  if (explicit) return explicit;
  const accounts = (await increase("GET", "/accounts?limit=10")).data.filter((a) => a.status === "open");
  if (accounts.length === 1) return accounts[0].id;
  throw new Error(
    `${accounts.length} open Increase accounts; set INCREASE_ACCOUNT_ID to say which one the ` +
      `customer account numbers belong on: ${accounts.map((a) => `${a.id} (${a.name})`).join(", ")}`,
  );
}

console.log(`\nProvider: ${BASE_URL}`);
console.log(`Account numbers at the provider: ${atProvider.length}`);
for (const n of atProvider) {
  const mapped = businesses.find((b) => b.provider_account_number_id === n.id);
  console.log(
    `  ${n.id}  ${n.routing_number}/${n.account_number}  debits=${n.inbound_ach?.debit_status}  ` +
      `${mapped ? `-> ${mapped.legal_name}` : "-> (unmapped)"}  "${n.name}"`,
  );
}

console.log(`\nBusinesses: ${businesses.length}`);
for (const b of businesses) {
  const state = b.provider_account_number_id
    ? `has ${b.routing_number}/${b.account_number}`
    : b.has_deposit_account
      ? "NEEDS A NUMBER"
      : "skipped — no 2100 deposit leaf, nowhere for money to land";
  console.log(`  ${b.legal_name.padEnd(46)} ${state}`);
}

if (LIST_ONLY) {
  await sql.end();
  process.exit(0);
}

const todo = businesses.filter((b) => b.has_deposit_account && !b.provider_account_number_id);
const unblocked = atProvider.filter(
  (n) => businesses.some((b) => b.provider_account_number_id === n.id) &&
    n.inbound_ach?.debit_status !== "blocked",
);

if (!APPLY) {
  console.log(
    `\nDRY RUN. Would issue ${todo.length} account number(s) and block inbound debits on ` +
      `${unblocked.length} existing one(s). Re-run with --apply.`,
  );
  await sql.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Issue, block, record
// ---------------------------------------------------------------------------

const fboAccountId = await resolveFboAccountId();
console.log(`\nIssuing on Increase account ${fboAccountId}\n`);

let issued = 0;
let reused = 0;
let recorded = 0;
let blocked = 0;

for (const b of todo) {
  // PROVIDER FIRST. A crash between here and the INSERT costs nothing: the
  // second run's POST is refused by the idempotency key and the number it
  // already issued is fetched instead. See `issueAccountNumber`.
  const { number, fresh } = await issueAccountNumber(b, fboAccountId);

  if (fresh && !byId.has(number.id)) issued += 1;
  else reused += 1;

  if (number.inbound_ach?.debit_status !== "blocked") {
    await increase("PATCH", `/account_numbers/${number.id}`, { inbound_ach: { debit_status: "blocked" } });
    blocked += 1;
  }

  // TABLE SECOND. ON CONFLICT DO NOTHING and not DO UPDATE: the table is
  // append-only and its trigger would refuse the UPDATE anyway. A conflict here
  // means the row already exists, which is the state we wanted.
  const [row] = await sql`
    INSERT INTO virtual_account_number
      (provider, provider_account_number_id, provider_account_id,
       routing_number, account_number, business_id, name, provider_created_at)
    VALUES (${PROVIDER}, ${number.id}, ${number.account_id},
            ${number.routing_number}, ${number.account_number}, ${b.id},
            ${number.name}, ${number.created_at}::timestamptz)
    ON CONFLICT (provider, provider_account_number_id) DO NOTHING
    RETURNING id`;
  if (row) recorded += 1;

  console.log(
    `  ${b.legal_name.padEnd(46)} ${number.routing_number}/${number.account_number}  ${number.id}` +
      `${row ? "" : "  (mapping row already present)"}`,
  );
}

// Any number already mapped but still accepting inbound debits.
for (const n of unblocked) {
  await increase("PATCH", `/account_numbers/${n.id}`, { inbound_ach: { debit_status: "blocked" } });
  blocked += 1;
  console.log(`  blocked inbound debits on ${n.id}`);
}

console.log(
  `\nissued ${issued} · reused ${reused} · recorded ${recorded} · inbound debits blocked ${blocked}`,
);

// ---------------------------------------------------------------------------
// The mapping, read back from the table that will decide
// ---------------------------------------------------------------------------

const mapping = await sql`
  SELECT v.routing_number, v.account_number, v.provider_account_number_id, b.legal_name
    FROM virtual_account_number v
    JOIN business b ON b.id = v.business_id
   WHERE v.provider = ${PROVIDER}
   ORDER BY b.legal_name`;

console.log("\nThe mapping an inbound credit is attributed through:\n");
for (const m of mapping) {
  console.log(
    `  ${m.routing_number} / ${m.account_number}  ${m.provider_account_number_id}  ${m.legal_name}`,
  );
}

const coverage = await sql`SELECT legal_name, coverage FROM v_virtual_account_number_coverage ORDER BY legal_name`;
console.log("\nCoverage (v_virtual_account_number_coverage — a report, rows are expected):\n");
for (const c of coverage) console.log(`  ${c.legal_name.padEnd(46)} ${c.coverage}`);

await sql.end();
