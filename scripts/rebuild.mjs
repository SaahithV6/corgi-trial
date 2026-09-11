#!/usr/bin/env node
/**
 * ===========================================================================
 * REBUILD THE BOOK FROM THE EVENT LOG, AND PROVE IT MATCHES.
 * ===========================================================================
 *
 *   node scripts/rebuild.mjs            summary
 *   node scripts/rebuild.mjs --verbose  every mismatch, with ids
 *   node scripts/rebuild.mjs --limit N  cap the statements re-rendered
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * Gauntlet item 1 says the available balance must be "derived and provable
 * from events -- never a second stored number that drifts and gets fixed by a
 * cron job". The rest of this repo argues that with invariant views: one
 * derivation held equal to another, inside the same database.
 *
 * A view agreeing with a view is a weaker claim than it looks. Both sides are
 * SQL, both run in the same engine, and a guard computed from the same input
 * as the thing it guards cannot fail. This script makes the strong form of the
 * claim instead: it throws the derived state away, rebuilds every number from
 * the immutable facts in plain JavaScript, and asserts the rebuild is
 * identical to what production reports.
 *
 * If the ledger drifted, this would print the drift. It is also an executable
 * specification: if you want to know what `available_cents` means, the answer
 * is `availability()` below and it is forty lines with no SQL in it.
 *
 * ---------------------------------------------------------------------------
 * INDEPENDENCE -- WHAT THIS SCRIPT IS AND IS NOT ALLOWED TO ASK POSTGRES
 * ---------------------------------------------------------------------------
 *
 * The rule is: consult the schema for a FACT, never for a DERIVATION.
 *
 * FACTS this script reads (raw rows, no aggregation, no predicate that
 * encodes a rule):
 *
 *     account            id, entity_id, code, name, type, book, business_id
 *     journal_entry      id, value_date, booking_seq, book, entry_type,
 *                        hold_id, description, external_ref, rail,
 *                        reverses_entry_id, correction_group_id, entity_id
 *     journal_line       entry_id, ordinal, account_id, amount_cents,
 *                        currency, value_date, booking_seq
 *     hold               id, account_id, memo_account_id, kind, value_date,
 *                        expires_at, available_at
 *     hold_closure       hold_id
 *     hold_closure_reversal  hold_id
 *     card_authorization id, hold_id, expires_at
 *     card_auth_event    auth_id, kind, amount_cents, is_final, received_at,
 *                        provider_event_id
 *     statement          the published artefact rows, to check against
 *     book_day           which days are closed
 *     business           names, for the report
 *     book_tz()          the book's timezone -- a configuration constant
 *
 * DERIVATIONS this script re-expresses in JavaScript, from the definitions,
 * and never asks Postgres for:
 *
 *     normal_side                   from account.type (it is a GENERATED
 *                                   column, which makes it a derivation)
 *     the value date of an instant  from book_tz() and Intl, not book_date()
 *     the settled ledger balance    not ledger_settled_cents()
 *     A(E), C(E), closed(E), H(E)   not v_card_auth_state / v_card_auth_hold
 *     a hold's memo balance         not v_hold_state
 *     the release predicate         both flavours of it, by hand
 *     the five availability terms   not ledger_availability(), not
 *                                   v_available_balance
 *     the trial balance             folded here from the loaded lines
 *     a statement's canonical form  re-expressed from the documented format
 *                                   in docs/STATEMENTS.md and the header of
 *                                   src/lib/statements/render.ts -- this file
 *                                   imports NOTHING from src/
 *
 * The script imports `postgres` and `node:crypto` and nothing else. It does
 * not import one line of application code, deliberately: importing
 * `balance-definitions.ts` would be asking the same code the same question.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY, AND STRUCTURALLY SO
 * ---------------------------------------------------------------------------
 *
 * It connects as `corgi_app`, which holds SELECT and INSERT on the money
 * tables and no UPDATE or DELETE at all, and it opens
 *
 *     BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
 *
 * so Postgres refuses any write this file could contain, and so every read
 * below comes from ONE MVCC snapshot. The second half matters as much as the
 * first: twelve agents write this repo concurrently and the book moves while
 * the script runs. Without a fixed snapshot a "mismatch" could simply be two
 * reads taken either side of a posting.
 *
 * ---------------------------------------------------------------------------
 * THE POINT IN THE TWO CLOCKS
 * ---------------------------------------------------------------------------
 *
 * A balance question has three arguments -- which business day, which booking
 * watermark, which instant -- so the comparison pins all three, once:
 *
 *     asOf      now(), which inside a transaction is the transaction's START
 *               and therefore does not move under us. It is also exactly the
 *               instant `v_hold_state` and `v_card_auth_hold` evaluate their
 *               own release predicates at, because they call now() too. That
 *               alignment is why the comparison is meaningful rather than a
 *               race.
 *     valueDate book_date(asOf), re-derived here from book_tz()
 *     watermark MAX(booking_seq) visible in this snapshot
 *
 * `v_available_balance` is deliberately NOT one of the things compared: it
 * pins itself to clock_timestamp(), which moves inside the transaction, so it
 * answers a question about a different instant every time it is read. Its
 * body is `ledger_availability()` at the live point, and that function IS
 * compared, at a point this script controls.
 *
 * ---------------------------------------------------------------------------
 * MONEY
 * ---------------------------------------------------------------------------
 *
 * bigint cents throughout. No float, no Number, no intermediate. Dates are
 * read as 'YYYY-MM-DD' text and compared lexicographically; timestamps are
 * read as fixed-width UTC text and compared lexicographically. Neither ever
 * becomes a JS Date, so there is no timezone or precision hazard anywhere in
 * this file.
 */

import { createHash } from "node:crypto";
import postgres from "postgres";

/* ========================================================================== */
/* 0. Argument handling and the connection                                    */
/* ========================================================================== */

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose") || argv.includes("-v");
const limitArg = argv.indexOf("--limit");
const STATEMENT_LIMIT =
  limitArg >= 0 && argv[limitArg + 1] ? Number.parseInt(argv[limitArg + 1], 10) : Infinity;

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error(
    "APP_DATABASE_URL is not set. This script must run as corgi_app, which holds\n" +
      "no UPDATE or DELETE on the money tables. Run `set -a; . ./.env; set +a` first.",
  );
  // 2 is "could not run", as distinct from 1, "ran and found a disagreement".
  // Collapsing the two would let a missing credential read as a clean book.
  process.exit(2);
}

const sql = postgres(url, {
  max: 1,
  onnotice: () => {},
  // BIGINT must not become a JS number: Number.MAX_SAFE_INTEGER is about
  // $90tn and a silent precision loss in a ledger is the worst class of bug
  // there is. Same configuration the application uses, for the same reason.
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (v) => v.toString(),
      parse: (v) => BigInt(v),
    },
  },
});

const started = process.hrtime.bigint();

/* ========================================================================== */
/* 1. The rebuild, as pure functions of facts                                 */
/* ========================================================================== */

/**
 * `account.normal_side`, re-derived.
 *
 * +1 for debit-normal (asset, expense), -1 for credit-normal. A customer's
 * deposit is a LIABILITY of the bank -- the customer having money is us owing
 * money -- so it is credit-normal, and every balance below multiplies by this
 * rather than branching on account type.
 *
 * The column exists in the schema but it is GENERATED ALWAYS, which makes it
 * a derivation and therefore not something this script may consult. It reads
 * `type`, computes this, and checks the two agree as one of the assertions.
 */
function normalSide(type) {
  return type === "asset" || type === "expense" ? 1n : -1n;
}

/**
 * The business day of an instant, without asking `book_date()`.
 *
 * The book settles on Fed/ACH calendars, which are Eastern, so a value date is
 * the instant rendered in `book_tz()`. `Intl` gives the civil date in a zone
 * with no arithmetic of our own and no DST special-casing.
 */
function bookDate(utcMillis, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(utcMillis));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Q1. The settled ledger balance of one account at (valueDate, watermark).
 *
 *     Sigma amount_cents x normal_side  over the account's lines, with
 *       value_date  <= valueDate     which business days count
 *       booking_seq <= watermark     what we had learned by then
 *
 * Both predicates are load-bearing and independent: hold the value date still
 * and move the watermark and you get "what did we believe on Wednesday"; hold
 * the watermark still and move the value date and you get "what does the book
 * say about Tuesday".
 *
 * FUTURE-DATED ENTRIES ARE EXCLUDED. A settlement booked today for tomorrow's
 * business day is a fact we know; it is not money the customer has today.
 */
function settled(lines, side, valueDate, watermark) {
  let total = 0n;
  for (const l of lines) {
    if (l.valueDate <= valueDate && l.bookingSeq <= watermark) total += l.amountCents;
  }
  return total * side;
}

/**
 * H(E), the card authorisation hold, as a pure function of an event SET.
 *
 *     A(E) = Sigma amount over {authorization, incremental_authorization}
 *          - Sigma amount over {authorization_reversal}
 *     C(E) = Sigma amount over {clearing, force_post}
 *     closed(E) = (exists e in E : e.isFinal)
 *               v (exists e in E : e.kind in {close, expiry})
 *               v (E non-empty and A(E) <= 0)
 *               v now >= expiresAt
 *     H(E) = 0                    if closed(E)
 *          = max(A(E) - C(E), 0)  otherwise
 *
 * Nothing here has an argument called "previous state", because there is no
 * previous state. Sigma, exists and max are permutation-invariant, so a
 * settlement arriving before its authorisation is not a case to handle -- it
 * is the same set assembled in a different order, and a function of a set
 * cannot tell the difference. Deduplication is by `providerEventId` here as
 * well as by a unique index in the database, so the claim "H is a function of
 * the set" holds at this layer too and not only at the one with the index.
 *
 * `declined` and `refund` appear in NO contributing set, and that is by
 * construction rather than by an arm someone has to remember: both folds
 * select by membership, so a kind in neither list is neutral in both.
 *
 * `expiresAt` is a PARAMETER rather than a field, because the two production
 * bodies read it from two different tables and this script compares them.
 */
function holdModel(events, expiresAt, asOf) {
  const seen = new Set();
  let authorised = 0n;
  let captured = 0n;
  let sawFinal = false;
  let sawClose = false;
  let count = 0;

  for (const ev of events) {
    if (seen.has(ev.providerEventId)) continue;
    seen.add(ev.providerEventId);
    count += 1;

    if (ev.amountCents < 0n) {
      throw new Error(
        `card event ${ev.providerEventId} has a negative magnitude (${ev.amountCents}); ` +
          "kind carries direction, amount does not",
      );
    }
    if (ev.kind === "authorization" || ev.kind === "incremental_authorization") {
      authorised += ev.amountCents;
    } else if (ev.kind === "authorization_reversal") {
      authorised -= ev.amountCents;
    }
    if (ev.kind === "clearing" || ev.kind === "force_post") captured += ev.amountCents;
    if (ev.isFinal) sawFinal = true;
    if (ev.kind === "expiry" || ev.kind === "close") sawClose = true;
  }

  // `A <= 0` needs the non-empty guard: an authorisation we have created an
  // identity for but heard nothing about yet has A = 0, and that is
  // OPEN-with-nothing-held, not CLOSED.
  const expired = expiresAt !== null && asOf >= expiresAt;
  const closed = sawFinal || sawClose || expired || (count > 0 && authorised <= 0n);
  const remainder = authorised - captured;

  return {
    authorisedCents: authorised,
    capturedCents: captured,
    sawFinal,
    sawClose,
    expired,
    closed,
    // The same conditions MINUS the one a later event can undo. This is the
    // predicate that may license an append-only closure row, so it must be
    // monotone: true on a subset implies true on every superset. `A <= 0` is
    // not -- a $0 card-on-file authorisation is `A <= 0` today and `A = 1` the
    // moment its advice lands.
    terminallyClosed: sawFinal || sawClose || expired,
    holdCents: closed ? 0n : remainder > 0n ? remainder : 0n,
    eventCount: count,
  };
}

/**
 * A hold's balance in the memo book: what we have actually posted against it.
 *
 * Restricted to the hold's OWN memo leaf. The 9900 contra leg sits in the same
 * balanced entry, so summing both legs gives zero, always, and a reader that
 * forgets the restriction gets a hold that never holds anything.
 *
 * A hold's BALANCE is a sum and its RELEASE is a predicate, and they are
 * deliberately separate: availability is `released ? 0 : balance`, so if the
 * physical release entry never lands the customer's available balance is still
 * right, and when it lands it drives the balance to 0 and the predicate is a
 * no-op. The two can never double-count.
 */
function memoBalance(entriesByHold, linesByEntry, memoAccountId, sideOf, watermark) {
  let total = 0n;
  for (const e of entriesByHold) {
    if (e.bookingSeq > watermark) continue;
    for (const l of linesByEntry.get(e.id) ?? []) {
      if (l.accountId === memoAccountId) total += l.amountCents * sideOf(l.accountId);
    }
  }
  return total;
}

/**
 * available = settled ledger
 *           - active holds            (card authorisations, manual holds)
 *           - active uncleared credits
 *           - committed future-dated debits
 *
 * Four decisions are written into this arithmetic and each one moved a real
 * figure on this database:
 *
 * (a) THE LEDGER TERM IS THE SETTLED ONE, not "every line". A credit
 *     value-dated 2027 is not spendable in 2026.
 *
 * (b) A FUTURE-DATED DEBIT IS SUBTRACTED ANYWAY, which is deliberately not
 *     symmetric with (a). Money already booked to leave has been committed,
 *     and a customer who can spend it again in the window before it settles is
 *     a customer we have overdrawn on their own behalf. This term is a DERIVED
 *     hold: it needs no hold row because the journal entry is already there,
 *     and it cannot double-count against a memo hold because the two live in
 *     different books. Netted per ENTRY, so an entry touching the account
 *     twice is one commitment and not two.
 *
 * (c) A HOLD ONLY WITHHOLDS FROM ITS OWN VALUE DATE. A hold value-dated
 *     tomorrow guards a credit that is not in the ledger term either;
 *     deducting it charges the customer for the same dollar twice.
 *
 * (d) MANUAL HOLDS COUNT. They are not card holds and they are not uncleared
 *     credits, and a definition that buckets only those two silently frees the
 *     money an operator placed a hold to withhold.
 *
 * Allowed to go negative on purpose. An over-captured fuel-pump authorisation
 * settles above the amount authorised; clamping at zero would hide a real
 * overdraft behind a cosmetic floor.
 */
function availability({ ledgerCents, holds, futureDebitsCents }) {
  let holdCents = 0n;
  let unclearedCents = 0n;
  for (const h of holds) {
    if (h.kind === "uncleared_credit") unclearedCents += h.contributionCents;
    else holdCents += h.contributionCents;
  }
  return {
    ledgerCents,
    holdCents,
    unclearedCents,
    pendingOutboundCents: futureDebitsCents,
    availableCents: ledgerCents - holdCents - unclearedCents - futureDebitsCents,
  };
}

/* -------------------------------------------------------------------------- */
/* The canonical statement, re-expressed                                      */
/* -------------------------------------------------------------------------- */

/**
 * The statement format, written out from its specification rather than
 * imported. `src/lib/statements/render.ts` is the production renderer and this
 * file does not touch it -- if the two disagree, one of them is wrong and the
 * mismatch is the finding.
 *
 * Every field is length-prefixed, `<utf8 byte length>:<value>`. Not because it
 * is tidy: a statement carries `description` and `external_ref`, which are
 * free text arriving from a provider, and with a plain delimiter a description
 * containing the delimiter could forge a different set of lines that hashes
 * identically. Netstrings make the preimage unambiguous whatever the text
 * contains, which in a tamper-evidence context is the difference between a
 * hash and a hash you can rely on.
 *
 * A nullable field carries a presence marker because `null`, `""` and the
 * literal text `"null"` are three different facts about a provider reference.
 */
const STATEMENT_FORMAT = "corgi.statement.v1";

const field = (v) => `${Buffer.byteLength(v, "utf8")}:${v}`;
const record = (tag, ...vs) => [tag, ...vs.map(field)].join(" ");
const optional = (v) => (v === null ? "-" : `+${v}`);

function canonicalStatement(doc) {
  // (value_date, booking_seq, ordinal) is a total order: booking_seq is unique
  // per entry and ordinal is unique within one. Applied here rather than
  // trusted from a query, so the canonical form is canonical whatever order
  // the rows arrived in.
  const lines = [...doc.lines].sort((a, b) => {
    if (a.valueDate !== b.valueDate) return a.valueDate < b.valueDate ? -1 : 1;
    if (a.bookingSeq !== b.bookingSeq) return a.bookingSeq < b.bookingSeq ? -1 : 1;
    return a.ordinal - b.ordinal;
  });

  const head = [
    record("format", STATEMENT_FORMAT),
    record("account", doc.accountId),
    record("period", doc.periodStart, doc.periodEnd),
    record("watermark", doc.bookingWatermark.toString()),
    record("opening", doc.openingBalanceCents.toString()),
    record("closing", doc.closingBalanceCents.toString()),
    record("count", lines.length.toString()),
  ];

  const body = lines.map((l) =>
    record(
      "line",
      l.valueDate,
      l.bookingSeq.toString(),
      l.ordinal.toString(),
      l.signedCents.toString(),
      l.entryType,
      optional(l.externalRef),
      optional(l.rail),
      optional(l.reversesEntryId),
      l.description,
    ),
  );

  // Trailing newline so a document with N lines can never be a prefix of one
  // with N+1.
  return `${[...head, ...body].join("\n")}\n`;
}

/* ========================================================================== */
/* 2. Findings                                                                */
/* ========================================================================== */

const findings = [];
const checks = [];

/**
 * `kind` separates the two things this script can report.
 *
 *   "rebuild"     the reconstruction and production disagree about a number.
 *                 One of the two is wrong and the interesting possibility is
 *                 that it is production.
 *   "consistency" two stored FACTS disagree with each other. The rebuild is
 *                 not a party to it; it is the thing that noticed.
 *
 * Both are findings and both fail the run. Conflating them would let a
 * schema-level inconsistency masquerade as an arithmetic one.
 */
function check(name, detail, kind = "rebuild") {
  checks.push({ name, detail, kind, mismatches: 0 });
  return checks[checks.length - 1];
}

/**
 * Record a disagreement.
 *
 * `labels` exists because one check in this file compares FACT against FACT
 * rather than production against the rebuild, and printing "database / rebuilt"
 * over two columns that are both the database would be a small lie in the one
 * place this script is asking to be believed.
 */
function mismatch(slot, id, expected, actual, note, labels) {
  slot.mismatches += 1;
  findings.push({
    check: slot.name,
    id,
    expected: String(expected),
    actual: String(actual),
    note,
    labels: labels ?? ["database", "rebuilt "],
  });
}

const usd = (c) => {
  const n = c < 0n ? -c : c;
  const s = `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
  return `${c < 0n ? "-" : ""}$${s}`;
};

/* ========================================================================== */
/* 3. Load the facts, rebuild, compare                                        */
/* ========================================================================== */

let exitCode = 0;

await sql
  .begin("isolation level repeatable read read only", async (tx) => {
    /* ---------------------------------------------------------------- */
    /* 3.1 The point in the two clocks                                  */
    /* ---------------------------------------------------------------- */

    // now(), not clock_timestamp(): inside a transaction now() is the
    // transaction's START, so it does not move under us, and it is the SAME
    // instant v_hold_state and v_card_auth_hold evaluate their own release
    // predicates at. Read as fixed-width UTC text and as epoch millis; the
    // text is what every comparison below uses, the millis only feed Intl.
    const [pt] = await tx`
      SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS as_of,
             (EXTRACT(EPOCH FROM now()) * 1000)::bigint                    AS as_of_ms,
             book_tz()                                                     AS tz,
             to_char(book_date(now()), 'YYYY-MM-DD')                       AS db_value_date,
             COALESCE((SELECT MAX(e.booking_seq) FROM journal_entry e), 0)::bigint AS watermark`;

    const asOf = pt.as_of;
    const watermark = pt.watermark;
    const valueDate = bookDate(Number(pt.as_of_ms), pt.tz);

    // The book's own day boundary, re-derived rather than asked for. If these
    // ever disagree the whole comparison is against the wrong business day, so
    // it is checked before anything is folded.
    const vdCheck = check("value date re-derived from book_tz()", `${pt.tz} -> ${valueDate}`);
    if (valueDate !== pt.db_value_date) {
      mismatch(vdCheck, "book_date(now())", pt.db_value_date, valueDate, "timezone derivation");
    }

    /* ---------------------------------------------------------------- */
    /* 3.2 The facts                                                    */
    /* ---------------------------------------------------------------- */

    const [accountRows, entryRows, lineRows, holdRows, closureRows, reversalRows, authRows, eventRows] =
      await Promise.all([
        tx`SELECT id, entity_id, code, name, type::text AS type, book::text AS book,
                  business_id, normal_side
             FROM account`,
        tx`SELECT id, to_char(value_date,'YYYY-MM-DD') AS value_date, booking_seq,
                  entity_id, book::text AS book, entry_type::text AS entry_type,
                  hold_id, description, external_ref, rail::text AS rail,
                  reverses_entry_id, correction_group_id
             FROM journal_entry`,
        tx`SELECT entry_id, ordinal, account_id, amount_cents, currency,
                  to_char(value_date,'YYYY-MM-DD') AS value_date, booking_seq
             FROM journal_line`,
        tx`SELECT id, account_id, memo_account_id, kind::text AS kind,
                  to_char(value_date,'YYYY-MM-DD') AS value_date,
                  to_char(expires_at   AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS expires_at,
                  to_char(available_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS available_at
             FROM hold`,
        tx`SELECT hold_id FROM hold_closure`,
        tx`SELECT hold_id FROM hold_closure_reversal`,
        tx`SELECT id, hold_id, account_id, provider, provider_auth_id,
                  to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS expires_at
             FROM card_authorization`,
        tx`SELECT auth_id, kind::text AS kind, amount_cents, is_final, provider_event_id,
                  to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS received_at
             FROM card_auth_event`,
      ]);

    /* ---------------------------------------------------------------- */
    /* 3.3 Indexes over the facts. No aggregation happened in Postgres. */
    /* ---------------------------------------------------------------- */

    const accounts = new Map();
    for (const a of accountRows) {
      accounts.set(a.id, {
        id: a.id,
        entityId: a.entity_id,
        code: a.code,
        name: a.name,
        type: a.type,
        book: a.book,
        businessId: a.business_id,
        side: normalSide(a.type),
        storedSide: BigInt(a.normal_side),
      });
    }
    const sideOf = (id) => accounts.get(id).side;

    // `normal_side` is GENERATED ALWAYS -- a derivation living in the schema.
    // This re-derives it from `type` and holds the two equal.
    const sideCheck = check("normal_side re-derived from account.type", `${accounts.size} accounts`);
    for (const a of accounts.values()) {
      if (a.side !== a.storedSide) {
        mismatch(sideCheck, `${a.code} ${a.id}`, a.storedSide, a.side, a.type);
      }
    }

    const entries = new Map();
    for (const e of entryRows) {
      entries.set(e.id, {
        id: e.id,
        valueDate: e.value_date,
        bookingSeq: e.booking_seq,
        entityId: e.entity_id,
        book: e.book,
        entryType: e.entry_type,
        holdId: e.hold_id,
        description: e.description,
        externalRef: e.external_ref,
        rail: e.rail,
        reversesEntryId: e.reverses_entry_id,
        correctionGroupId: e.correction_group_id,
      });
    }

    const linesByEntry = new Map();
    const linesByAccount = new Map();
    for (const l of lineRows) {
      const entry = entries.get(l.entry_id);
      const line = {
        entryId: l.entry_id,
        ordinal: l.ordinal,
        accountId: l.account_id,
        amountCents: l.amount_cents,
        currency: l.currency.trim(),
        // The ENTRY's clocks are the authority; journal_line carries
        // denormalised copies, checked against these below.
        valueDate: entry.valueDate,
        bookingSeq: entry.bookingSeq,
        denormValueDate: l.value_date,
        denormBookingSeq: l.booking_seq,
        entry,
      };
      if (!linesByEntry.has(l.entry_id)) linesByEntry.set(l.entry_id, []);
      linesByEntry.get(l.entry_id).push(line);
      if (!linesByAccount.has(l.account_id)) linesByAccount.set(l.account_id, []);
      linesByAccount.get(l.account_id).push(line);
    }

    const entriesByHold = new Map();
    for (const e of entries.values()) {
      if (e.holdId === null) continue;
      if (!entriesByHold.has(e.holdId)) entriesByHold.set(e.holdId, []);
      entriesByHold.get(e.holdId).push(e);
    }

    const closed = new Set(closureRows.map((r) => r.hold_id));
    const closureReversed = new Set(reversalRows.map((r) => r.hold_id));

    const eventsByAuth = new Map();
    for (const ev of eventRows) {
      if (!eventsByAuth.has(ev.auth_id)) eventsByAuth.set(ev.auth_id, []);
      eventsByAuth.get(ev.auth_id).push({
        kind: ev.kind,
        amountCents: ev.amount_cents,
        isFinal: ev.is_final,
        providerEventId: ev.provider_event_id,
        receivedAt: ev.received_at,
      });
    }

    const authsByHold = new Map();
    for (const a of authRows) {
      if (!authsByHold.has(a.hold_id)) authsByHold.set(a.hold_id, []);
      authsByHold.get(a.hold_id).push(a);
    }

    const holds = holdRows.map((h) => ({
      id: h.id,
      accountId: h.account_id,
      memoAccountId: h.memo_account_id,
      kind: h.kind,
      valueDate: h.value_date,
      expiresAt: h.expires_at,
      availableAt: h.available_at,
    }));

    /* ---------------------------------------------------------------- */
    /* 3.4 Structural facts that fall out for free                      */
    /* ---------------------------------------------------------------- */

    // journal_line carries denormalised copies of the entry's two clocks.
    // Normally a hazard; safe here only because the source row is immutable.
    // This is the proof of that, folded from the rows rather than asked of
    // v_line_denorm_drift.
    const denorm = check("journal_line clocks match their entry", `${lineRows.length} lines`);
    for (const ls of linesByEntry.values()) {
      for (const l of ls) {
        if (l.denormValueDate !== l.valueDate || l.denormBookingSeq !== l.bookingSeq) {
          mismatch(
            denorm,
            `${l.entryId}#${l.ordinal}`,
            `${l.valueDate}/${l.bookingSeq}`,
            `${l.denormValueDate}/${l.denormBookingSeq}`,
          );
        }
      }
    }

    // Every entry sums to zero per currency, and every line's account is in
    // the entry's own book -- which is what makes "an authorisation cannot
    // move the ledger balance" true by construction rather than by care.
    const balanced = check("every entry sums to zero, per currency", `${entries.size} entries`);
    const bookPure = check("every line sits in its entry's book", `${entries.size} entries`);
    for (const [entryId, ls] of linesByEntry) {
      const byCurrency = new Map();
      for (const l of ls) {
        byCurrency.set(l.currency, (byCurrency.get(l.currency) ?? 0n) + l.amountCents);
        if (accounts.get(l.accountId).book !== entries.get(entryId).book) {
          mismatch(
            bookPure,
            `${entryId}#${l.ordinal}`,
            entries.get(entryId).book,
            accounts.get(l.accountId).book,
            accounts.get(l.accountId).code,
          );
        }
      }
      for (const [cur, total] of byCurrency) {
        if (total !== 0n) mismatch(balanced, entryId, "0", total, cur);
      }
    }

    /* ---------------------------------------------------------------- */
    /* 3.5 THE LEDGER BALANCE, for every account                        */
    /* ---------------------------------------------------------------- */

    const rebuiltLedger = new Map();
    for (const a of accounts.values()) {
      rebuiltLedger.set(a.id, settled(linesByAccount.get(a.id) ?? [], a.side, valueDate, watermark));
    }

    // Production's answer: ledger_settled_cents(), one LATERAL over the whole
    // chart so it is one round trip rather than fifty-three.
    const productionLedger = await tx`
      SELECT a.id, ledger_settled_cents(a.id, ${valueDate}::date, ${watermark}::bigint) AS cents
        FROM account a`;

    const ledgerCheck = check(
      "settled ledger balance, every account",
      `${accounts.size} accounts at ${valueDate} / seq ${watermark}`,
    );
    for (const row of productionLedger) {
      const mine = rebuiltLedger.get(row.id);
      if (mine !== row.cents) {
        const a = accounts.get(row.id);
        mismatch(ledgerCheck, `${a.code} ${a.name} ${row.id}`, row.cents, mine);
      }
    }

    /* ---------------------------------------------------------------- */
    /* 3.6 H(E) AND THE HOLD MODEL, for every authorisation             */
    /* ---------------------------------------------------------------- */

    // Two production bodies evaluate the card model, and they read `expires_at`
    // from two DIFFERENT tables: v_card_auth_hold uses
    // card_authorization.expires_at, ledger_availability() uses
    // hold.expires_at. If a pair disagrees the two bodies release the same hold
    // at different instants, so the pair is checked rather than assumed.
    //
    // This is the one comparison in the file that is FACT against FACT rather
    // than rebuild against production, and it is labelled that way so a reader
    // does not mistake a finding here for an arithmetic disagreement.
    const holdById = new Map(holds.map((h) => [h.id, h]));
    const expiryCheck = check(
      "hold.expires_at agrees with its authorisation's",
      `${authRows.length} authorisations; two release predicates read these two columns`,
      "consistency",
    );
    for (const a of authRows) {
      const h = holdById.get(a.hold_id);
      if (h && h.expiresAt !== a.expires_at) {
        mismatch(
          expiryCheck,
          `auth ${a.id} / hold ${a.hold_id}`,
          h.expiresAt,
          a.expires_at,
          "two separate clock reads at insert time; the two release predicates disagree " +
            "for the gap between them, seven days from now",
          ["hold          ", "authorisation "],
        );
      }
    }

    const rebuiltAuth = new Map();
    for (const a of authRows) {
      rebuiltAuth.set(a.id, holdModel(eventsByAuth.get(a.id) ?? [], a.expires_at, asOf));
    }

    const productionAuth = await tx`
      SELECT auth_id, hold_id,
             auth_net_cents::bigint     AS auth_net_cents,
             captured_cents::bigint     AS captured_cents,
             saw_final, saw_close, event_count::bigint AS event_count,
             is_closed,
             target_hold_cents::bigint  AS target_hold_cents
        FROM v_card_auth_hold`;

    const modelCheck = check("H(E) folded from the card event set", `${authRows.length} authorisations`);
    for (const row of productionAuth) {
      const mine = rebuiltAuth.get(row.auth_id);
      if (mine === undefined) {
        mismatch(modelCheck, row.auth_id, "an authorisation row", "none loaded");
        continue;
      }
      const disagreements = [];
      if (mine.authorisedCents !== row.auth_net_cents) disagreements.push(`A ${row.auth_net_cents}/${mine.authorisedCents}`);
      if (mine.capturedCents !== row.captured_cents) disagreements.push(`C ${row.captured_cents}/${mine.capturedCents}`);
      if (mine.sawFinal !== row.saw_final) disagreements.push(`final ${row.saw_final}/${mine.sawFinal}`);
      if (mine.sawClose !== row.saw_close) disagreements.push(`close ${row.saw_close}/${mine.sawClose}`);
      if (BigInt(mine.eventCount) !== row.event_count) disagreements.push(`n ${row.event_count}/${mine.eventCount}`);
      if (mine.closed !== row.is_closed) disagreements.push(`closed ${row.is_closed}/${mine.closed}`);
      if (mine.holdCents !== row.target_hold_cents) disagreements.push(`H ${row.target_hold_cents}/${mine.holdCents}`);
      if (disagreements.length > 0) {
        mismatch(modelCheck, `auth ${row.auth_id} hold ${row.hold_id}`, row.target_hold_cents, mine.holdCents, disagreements.join(" "));
      }
    }

    /* ---------------------------------------------------------------- */
    /* 3.7 THE HOLD STATE, for every hold                               */
    /* ---------------------------------------------------------------- */

    /**
     * `v_hold_state`'s release predicate, re-expressed.
     *
     *   a closure row that has not itself been reversed, OR
     *   a card hold the fold says is closed, OR
     *   an uncleared credit whose availability moment has arrived
     *
     * Note what is NOT in it: any provider status field. Lithic reports
     * SETTLED while a partial hold is still outstanding, and a release keyed
     * off that frees money the network still has authorised.
     */
    function releasedByHoldState(h) {
      if (closed.has(h.id) && !closureReversed.has(h.id)) return true;
      if (h.kind === "card_auth") {
        const auths = authsByHold.get(h.id) ?? [];
        // The view's correlated subquery takes ONE matching row; with the
        // pairing one-to-one this is the same set.
        return auths.some((a) => rebuiltAuth.get(a.id).closed);
      }
      if (h.kind === "uncleared_credit") return h.availableAt !== null && asOf >= h.availableAt;
      return false;
    }

    const rebuiltHold = new Map();
    for (const h of holds) {
      const balance = memoBalance(
        entriesByHold.get(h.id) ?? [],
        linesByEntry,
        h.memoAccountId,
        sideOf,
        watermark,
      );
      const released = releasedByHoldState(h);
      rebuiltHold.set(h.id, { balance, released, active: released ? 0n : balance });
    }

    const productionHold = await tx`
      SELECT hold_id, memo_balance_cents::bigint AS memo_balance_cents,
             is_released, active_hold_cents::bigint AS active_hold_cents
        FROM v_hold_state`;

    const holdCheck = check("hold memo balance and release, every hold", `${holds.length} holds`);
    for (const row of productionHold) {
      const mine = rebuiltHold.get(row.hold_id);
      if (mine === undefined) {
        mismatch(holdCheck, row.hold_id, "a hold row", "none loaded");
        continue;
      }
      const d = [];
      if (mine.balance !== row.memo_balance_cents) d.push(`memo ${row.memo_balance_cents}/${mine.balance}`);
      if (mine.released !== row.is_released) d.push(`released ${row.is_released}/${mine.released}`);
      if (mine.active !== row.active_hold_cents) d.push(`active ${row.active_hold_cents}/${mine.active}`);
      if (d.length > 0) mismatch(holdCheck, row.hold_id, row.active_hold_cents, mine.active, d.join(" "));
    }

    // A released hold must be FLAT: whatever it withheld has been given back in
    // the memo book. Anything else is availability and the memo book
    // disagreeing about the same hold, which is the shape of every
    // over-release bug there is. Reported as a finding, never repaired.
    const flat = check("a released hold holds nothing", `${holds.length} holds`);
    for (const h of holds) {
      const r = rebuiltHold.get(h.id);
      if (r.released && r.balance !== 0n) {
        mismatch(flat, h.id, "0", r.balance, `${h.kind}, released with money still withheld`);
      }
    }

    /* ---------------------------------------------------------------- */
    /* 3.8 AVAILABILITY, for every customer deposit account             */
    /* ---------------------------------------------------------------- */

    /**
     * `ledger_availability()`'s release predicate, which is NOT the same body
     * as `v_hold_state`'s: it evaluates at a parameterised instant, it reads
     * `hold.expires_at` rather than the authorisation's, and it folds only the
     * events received by that instant. Re-expressed separately for exactly
     * that reason -- collapsing the two here would hide a difference between
     * them instead of finding one.
     */
    function releasedByAvailability(h) {
      if (closed.has(h.id) && !closureReversed.has(h.id)) return true;
      if (h.kind === "card_auth") {
        const events = (authsByHold.get(h.id) ?? []).flatMap((a) =>
          (eventsByAuth.get(a.id) ?? []).filter((ev) => ev.receivedAt <= asOf),
        );
        const m = holdModel(events, h.expiresAt, asOf);
        return m.sawFinal || m.sawClose || m.expired || (m.eventCount > 0 && m.authorisedCents <= 0n);
      }
      if (h.kind === "uncleared_credit") return h.availableAt !== null && asOf >= h.availableAt;
      return false;
    }

    const holdsByAccount = new Map();
    for (const h of holds) {
      if (!holdsByAccount.has(h.accountId)) holdsByAccount.set(h.accountId, []);
      holdsByAccount.get(h.accountId).push(h);
    }

    // The customer deposit leaves: bare code '2100' in the financial book with
    // a business. Pot sub-accounts carry a qualified code ('2100.<uuid>'), so
    // the bare code is the spendable leaf and pots are excluded by
    // construction rather than by a predicate someone has to remember.
    const depositAccounts = [...accounts.values()].filter(
      (a) => a.code === "2100" && a.book === "financial" && a.businessId !== null,
    );

    const rebuiltAvailability = new Map();
    for (const a of depositAccounts) {
      // (c) a hold only withholds from its own value date.
      const live = (holdsByAccount.get(a.id) ?? [])
        .filter((h) => h.valueDate <= valueDate && !releasedByAvailability(h))
        .map((h) => ({
          kind: h.kind,
          contributionCents: memoBalance(
            entriesByHold.get(h.id) ?? [],
            linesByEntry,
            h.memoAccountId,
            sideOf,
            watermark,
          ),
        }));

      // (b) committed future-dated debits, netted per ENTRY.
      const perEntry = new Map();
      for (const l of linesByAccount.get(a.id) ?? []) {
        if (l.valueDate > valueDate && l.bookingSeq <= watermark) {
          perEntry.set(l.entryId, (perEntry.get(l.entryId) ?? 0n) + l.amountCents * a.side);
        }
      }
      let futureDebitsCents = 0n;
      for (const delta of perEntry.values()) if (delta < 0n) futureDebitsCents -= delta;

      rebuiltAvailability.set(
        a.id,
        availability({ ledgerCents: rebuiltLedger.get(a.id), holds: live, futureDebitsCents }),
      );
    }

    const productionAvailability = await tx`
      SELECT a.id, av.ledger_cents, av.hold_cents, av.uncleared_cents,
             av.pending_outbound_cents, av.available_cents
        FROM account a
        CROSS JOIN LATERAL ledger_availability(
          a.id, ${valueDate}::date, ${watermark}::bigint, now()) av
       WHERE a.book = 'financial' AND a.business_id IS NOT NULL AND a.code = '2100'`;

    const availCheck = check(
      "available balance and its five terms",
      `${depositAccounts.length} customer deposit accounts`,
    );
    const seenAvailability = new Set();
    for (const row of productionAvailability) {
      seenAvailability.add(row.id);
      const mine = rebuiltAvailability.get(row.id);
      if (mine === undefined) {
        mismatch(availCheck, row.id, "an account this script selected", "not selected");
        continue;
      }
      const terms = [
        ["ledger", mine.ledgerCents, row.ledger_cents],
        ["holds", mine.holdCents, row.hold_cents],
        ["uncleared", mine.unclearedCents, row.uncleared_cents],
        ["committed out", mine.pendingOutboundCents, row.pending_outbound_cents],
        ["available", mine.availableCents, row.available_cents],
      ];
      const d = terms.filter(([, m, p]) => m !== p).map(([n, m, p]) => `${n} db=${p} rebuilt=${m}`);
      if (d.length > 0) {
        const a = accounts.get(row.id);
        mismatch(availCheck, `${a.name} ${row.id}`, row.available_cents, mine.availableCents, d.join("; "));
      }
    }
    for (const a of depositAccounts) {
      if (!seenAvailability.has(a.id)) {
        mismatch(availCheck, a.id, "a row from ledger_availability()", "none", a.name);
      }
    }

    /* ---------------------------------------------------------------- */
    /* 3.9 THE TRIAL BALANCE                                            */
    /* ---------------------------------------------------------------- */

    // The whole book nets to zero, per entity and per book, EXACTLY -- not
    // "within a penny". This is what the rounding rule protects: every
    // allocation gives its residual penny to a real line, so nothing is ever
    // silently truncated.
    const rebuiltBooks = new Map();
    let rebuiltAll = 0n;
    for (const ls of linesByEntry.values()) {
      for (const l of ls) {
        rebuiltAll += l.amountCents;
        const key = `${l.entry.entityId}|${l.entry.book}|${l.currency}`;
        rebuiltBooks.set(key, (rebuiltBooks.get(key) ?? 0n) + l.amountCents);
      }
    }

    const productionBooks = await tx`
      SELECT e.entity_id, e.book::text AS book, l.currency,
             SUM(l.amount_cents)::bigint AS sum_cents
        FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
       GROUP BY e.entity_id, e.book, l.currency`;

    const tbCheck = check("trial balance, per entity and per book", `${rebuiltBooks.size} (entity, book, currency) groups`);
    if (rebuiltAll !== 0n) mismatch(tbCheck, "whole book", "0", rebuiltAll, "sum of every line");
    for (const row of productionBooks) {
      const key = `${row.entity_id}|${row.book}|${row.currency.trim()}`;
      const mine = rebuiltBooks.get(key) ?? 0n;
      if (mine !== row.sum_cents) mismatch(tbCheck, key, row.sum_cents, mine, "rebuild disagrees with the database's own SUM");
      else if (mine !== 0n) mismatch(tbCheck, key, "0", mine, "this book does not net to zero");
    }

    /* ---------------------------------------------------------------- */
    /* 3.10 THE STATEMENT CONTENT HASH                                  */
    /* ---------------------------------------------------------------- */

    const statementRows = await tx`
      SELECT s.id, s.account_id,
             to_char(s.period_start,'YYYY-MM-DD') AS period_start,
             to_char(s.period_end,'YYYY-MM-DD')   AS period_end,
             s.version, s.booking_watermark,
             s.opening_balance_cents, s.closing_balance_cents, s.line_count,
             encode(s.content_hash,'hex') AS content_hash, s.format,
             (SELECT count(*)::int FROM book_day bd
               WHERE bd.entity_id = a.entity_id
                 AND bd.business_date = s.period_end) AS day_closed
        FROM statement s JOIN account a ON a.id = s.account_id
       ORDER BY s.period_end, s.version`;

    const toRender = statementRows.slice(0, Number.isFinite(STATEMENT_LIMIT) ? STATEMENT_LIMIT : undefined);
    const closedDays = toRender.filter((s) => s.day_closed > 0).length;

    const stmtCheck = check(
      "statement content hash, re-rendered from the journal",
      `${toRender.length} published statements, ${closedDays} on a closed day`,
    );

    for (const s of toRender) {
      if (s.format !== STATEMENT_FORMAT) {
        // A hash is only comparable against a hash from the same renderer. A
        // format mismatch is a deployment fact, not a ledger fact, and saying
        // so is the difference between an alarm and an alarm nobody reads.
        mismatch(stmtCheck, s.id, STATEMENT_FORMAT, s.format, "different renderer; hashes not comparable");
        continue;
      }

      const acct = accounts.get(s.account_id);
      const all = linesByAccount.get(s.account_id) ?? [];
      const wm = s.booking_watermark;

      // opening -- everything strictly BEFORE the period, at the watermark.
      let opening = 0n;
      for (const l of all) {
        if (l.valueDate < s.period_start && l.bookingSeq <= wm) opening += l.amountCents;
      }
      opening *= acct.side;

      // lines -- everything INSIDE the period, at the watermark, financial
      // book only.
      const lines = [];
      for (const l of all) {
        if (l.valueDate < s.period_start || l.valueDate > s.period_end) continue;
        if (l.bookingSeq > wm) continue;
        if (l.entry.book !== "financial") continue;
        lines.push({
          valueDate: l.valueDate,
          bookingSeq: l.bookingSeq,
          ordinal: l.ordinal,
          signedCents: l.amountCents * acct.side,
          entryType: l.entry.entryType,
          externalRef: l.entry.externalRef,
          rail: l.entry.rail,
          reversesEntryId: l.entry.reversesEntryId,
          description: l.entry.description,
        });
      }

      // closing = opening + Sigma lines, folded here so the stored figure has
      // exactly one definition rather than a second SUM that could disagree
      // with the first two.
      let closing = opening;
      for (const l of lines) closing += l.signedCents;

      const doc = {
        accountId: s.account_id,
        periodStart: s.period_start,
        periodEnd: s.period_end,
        bookingWatermark: wm,
        openingBalanceCents: opening,
        closingBalanceCents: closing,
        lines,
      };
      const hash = createHash("sha256").update(canonicalStatement(doc), "utf8").digest("hex");

      const d = [];
      if (opening !== s.opening_balance_cents) d.push(`opening db=${s.opening_balance_cents} rebuilt=${opening}`);
      if (closing !== s.closing_balance_cents) d.push(`closing db=${s.closing_balance_cents} rebuilt=${closing}`);
      if (lines.length !== s.line_count) d.push(`lines db=${s.line_count} rebuilt=${lines.length}`);
      if (hash !== s.content_hash) d.push(`hash db=${s.content_hash.slice(0, 16)} rebuilt=${hash.slice(0, 16)}`);
      if (d.length > 0) {
        mismatch(
          stmtCheck,
          `statement ${s.id} ${s.period_start}..${s.period_end} v${s.version}`,
          s.content_hash.slice(0, 16),
          hash.slice(0, 16),
          d.join("; "),
        );
      }
    }

    /* ---------------------------------------------------------------- */
    /* 3.11 THE ONE THING A REBUILD FROM THESE ROWS CAN PARTLY SEE       */
    /* ---------------------------------------------------------------- */
    //
    // A rebuild from the same rows cannot detect a row that was never written.
    // This is the one edge of that gap it can reach, and it is the only check
    // in this file that reads a source OUTSIDE the ledger: the raw provider
    // payload the inbox accepted. A delivery the dispatcher marked `done`
    // asserts facts the book must contain, and a fact the provider told us
    // that never became a row is invisible to every amount of re-folding.
    //
    // Two claims, both presence-only:
    //
    //   the transaction token names a card_authorization
    //   every event token inside it names a card_auth_event
    //
    // Deliberately NOT the amounts or the kinds. Re-deriving our card
    // vocabulary from Lithic's would be a second copy of
    // `src/lib/holds/lithic-events.ts` — 485 lines with real judgement in them
    // — and a second copy of a mapper is exactly the failure this script
    // exists to avoid. So this proves the rows exist, not that they are right,
    // and docs/REBUILD.md says so in those words.
    //
    // The `events` array is skipped for the kinds the adapter recognises and
    // deliberately drops (BALANCE_INQUIRY, CREDIT_AUTHORIZATION): storing a
    // zero-amount row would add a member to E that moves `count(*)` — which
    // the `A <= 0` closure arm guards on — without moving any sum. Those are
    // named here rather than inferred, so adding a third drop silently would
    // show up as a finding.
    const ADAPTER_DROPS = new Set(["BALANCE_INQUIRY", "CREDIT_AUTHORIZATION"]);

    const inboxRows = await tx`
      SELECT id, provider_event_id, payload
        FROM webhook_inbox
       WHERE provider = 'lithic'
         AND event_type = 'card_transaction.updated'
         AND state = 'done'`;

    const knownAuthTokens = new Set(authRows.map((a) => a.provider_auth_id));
    const knownEventIds = new Set(eventRows.map((e) => e.provider_event_id));

    const coverage = check(
      "every settled lithic delivery is present in the book",
      `${inboxRows.length} card_transaction.updated deliveries marked done`,
    );
    let eventTokens = 0;
    let doubleEncoded = 0;
    for (const row of inboxRows) {
      // Three rows in this inbox are stored double-encoded: a bare `::jsonb`
      // cast makes the driver send a JSON-typed parameter and Postgres quotes
      // it a SECOND time, so `payload->>'token'` reads nothing. The posting
      // path was fixed to `::text::jsonb`; the rows written before it stayed,
      // because nothing in this system rewrites a row. Decoded here rather
      // than skipped, so the check covers them too.
      let payload = row.payload;
      if (typeof payload === "string") {
        doubleEncoded += 1;
        try {
          payload = JSON.parse(payload);
        } catch {
          mismatch(coverage, `inbox ${row.id}`, "a JSON payload", "unparseable text");
          continue;
        }
      }
      if (payload === null || typeof payload !== "object") continue;

      const token = payload.token;
      if (typeof token === "string" && !knownAuthTokens.has(token)) {
        mismatch(
          coverage,
          `inbox ${row.id} (${row.provider_event_id})`,
          `card_authorization for transaction ${token}`,
          "no such row",
          "a delivery we accepted names a card transaction the book has no identity for",
        );
      }
      for (const ev of Array.isArray(payload.events) ? payload.events : []) {
        if (typeof ev?.token !== "string") continue;
        if (ADAPTER_DROPS.has(ev.type)) continue;
        eventTokens += 1;
        if (!knownEventIds.has(ev.token)) {
          mismatch(
            coverage,
            `inbox ${row.id} event ${ev.token}`,
            "a card_auth_event row",
            "no such row",
            `${ev.type} was delivered and accepted but never entered E`,
          );
        }
      }
    }
    coverage.detail += `; ${eventTokens} provider event tokens, ${doubleEncoded} double-encoded payload(s) decoded`;

    /* ---------------------------------------------------------------- */
    /* 3.12 The report                                                  */
    /* ---------------------------------------------------------------- */

    const businesses = new Map((await tx`SELECT id, legal_name FROM business`).map((b) => [b.id, b.legal_name]));

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    console.log("");
    console.log("  REBUILD — the book, reconstructed from its events and compared to production");
    console.log("  " + "=".repeat(74));
    console.log(`  as of            ${asOf}Z   (now(), fixed for the whole transaction)`);
    console.log(`  value date       ${valueDate}             (re-derived from book_tz() = ${pt.tz})`);
    console.log(`  watermark        booking_seq <= ${watermark}`);
    console.log(`  isolation        REPEATABLE READ, READ ONLY, as ${"corgi_app"}`);
    console.log("");
    console.log("  FACTS FOLDED");
    console.log(`    accounts               ${String(accounts.size).padStart(7)}`);
    console.log(`    journal entries        ${String(entries.size).padStart(7)}`);
    console.log(`    journal lines          ${String(lineRows.length).padStart(7)}`);
    console.log(`    holds                  ${String(holds.length).padStart(7)}  (${closureRows.length} closed, ${reversalRows.length} closure reversed)`);
    console.log(`    card authorisations    ${String(authRows.length).padStart(7)}`);
    console.log(`    card auth events       ${String(eventRows.length).padStart(7)}`);
    console.log(`    published statements   ${String(statementRows.length).padStart(7)}  (${closedDays} on a closed book day)`);
    console.log("");
    console.log("  CHECKS");
    for (const c of checks) {
      const verdict = c.mismatches === 0 ? "  OK  " : "MISMATCH";
      console.log(`    ${verdict}  ${c.name}`);
      console.log(`              ${c.detail}${c.mismatches ? ` — ${c.mismatches} mismatch(es)` : ""}`);
    }

    console.log("");
    console.log("  THE CUSTOMER DEPOSIT ACCOUNTS, REBUILT");
    console.log(
      "    " +
        "business".padEnd(34) +
        "ledger".padStart(14) +
        "holds".padStart(12) +
        "uncleared".padStart(13) +
        "committed".padStart(13) +
        "available".padStart(14),
    );
    const ordered = [...depositAccounts].sort((a, b) =>
      (businesses.get(a.businessId) ?? "").localeCompare(businesses.get(b.businessId) ?? ""),
    );
    for (const a of ordered) {
      const v = rebuiltAvailability.get(a.id);
      const name = (businesses.get(a.businessId) ?? a.name).slice(0, 33);
      console.log(
        "    " +
          name.padEnd(34) +
          usd(v.ledgerCents).padStart(14) +
          usd(v.holdCents).padStart(12) +
          usd(v.unclearedCents).padStart(13) +
          usd(v.pendingOutboundCents).padStart(13) +
          usd(v.availableCents).padStart(14),
      );
    }

    const rebuildMismatches = checks
      .filter((c) => c.kind === "rebuild")
      .reduce((n, c) => n + c.mismatches, 0);
    const consistencyMismatches = checks
      .filter((c) => c.kind === "consistency")
      .reduce((n, c) => n + c.mismatches, 0);
    const totalMismatches = rebuildMismatches + consistencyMismatches;

    console.log("");
    console.log("  " + "=".repeat(74));
    console.log(
      `  ${checks.length} checks · ${rebuildMismatches} rebuild disagreement(s) · ` +
        `${consistencyMismatches} fact-vs-fact disagreement(s) · ${elapsedMs.toFixed(0)} ms wall clock`,
    );

    if (totalMismatches > 0) {
      console.log("");
      console.log("  FINDINGS. A mismatch is NOT evidence that the rebuild is wrong. Read each one");
      console.log("  as a question about which of the two answers is right, and investigate before");
      console.log("  assuming. Nothing here is repaired: this script holds no UPDATE and no DELETE.");
      console.log("");
      const show = VERBOSE ? findings : findings.slice(0, 25);
      for (const f of show) {
        console.log(`    [${f.check}]`);
        console.log(`      id       ${f.id}`);
        console.log(`      ${f.labels[0]} ${f.expected}`);
        console.log(`      ${f.labels[1]} ${f.actual}`);
        if (f.note) console.log(`      detail   ${f.note}`);
      }
      if (!VERBOSE && findings.length > show.length) {
        console.log(`    … ${findings.length - show.length} more; run with --verbose`);
      }
      exitCode = 1;
    } else {
      console.log("");
      console.log("  Every derived quantity in this book was reconstructed from its immutable");
      console.log("  facts in JavaScript and agreed with production exactly. What that does NOT");
      console.log("  prove is in docs/REBUILD.md, and reading it is the point.");
    }
    console.log("");
  })
  .catch((error) => {
    console.error("\n  REBUILD FAILED TO RUN\n");
    console.error(`  ${error.message}`);
    if (VERBOSE) console.error(error);
    exitCode = 2;
  });

await sql.end();
process.exit(exitCode);
