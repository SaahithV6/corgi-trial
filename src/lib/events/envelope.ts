/**
 * The event body: what a customer actually receives, and why it is shaped
 * like a pointer rather than like a payload.
 *
 * ===========================================================================
 * ORDERING IS NOT GUARANTEED, AND THE BODY SAYS SO IN BAND
 * ===========================================================================
 *
 * We retry, we fan out to more than one endpoint, and more than one worker
 * can be draining the queue. Any one of those is enough to reorder deliveries
 * relative to the order the facts occurred in, and the first is enough on its
 * own: a delivery that fails once and succeeds on its third attempt arrives
 * after everything queued behind it.
 *
 * This build exists BECAUSE providers deliver out of order — `dispatch.ts`
 * opens with "Out-of-order is not a case. The dispatcher makes no ordering
 * promise at all, so consumers cannot come to depend on one." Promising our
 * own customers otherwise would be a lie we would then have to keep, across
 * every retry, every deploy and every future worker.
 *
 * So the envelope gives a customer what they need to reconstruct order
 * WITHOUT trusting arrival:
 *
 *   sequence      `journal_entry.booking_seq` — the ledger's own total order,
 *                 assigned under a serialised lock so sequence order IS commit
 *                 order (0001 §14). It is the same integer the public API
 *                 publishes as `booking_seq` on every transaction and builds
 *                 its pagination cursor from, so an event and an API row about
 *                 the same fact carry the same number. Sort on this.
 *
 *   occurred_at   WHEN WE LEARNED IT (`booking_time`).
 *   value_date    WHEN IT HAPPENED (`value_date`).
 *
 *                 Both, always, because they are different and a backdated
 *                 correction is exactly where treating either one as "the
 *                 date" goes wrong. A reversal booked on Thursday for
 *                 Tuesday's settlement carries Tuesday's `value_date` and
 *                 Thursday's `occurred_at`, and a customer's daily file has to
 *                 know which axis it is aggregating on.
 *
 * ===========================================================================
 * THE BODY IS A POINTER
 * ===========================================================================
 *
 * `links` names the API resources that hold the authoritative state, and the
 * contract is: THE EVENT TELLS YOU SOMETHING CHANGED; THE API TELLS YOU WHAT
 * IS TRUE NOW. That is not a hedge, it is the same design decision this
 * build's own Plaid consumer runs on — Plaid ships notification-shaped
 * webhooks whose consumer re-fetches, and `webhooks/README.md` §2 explains
 * that processing one twice reaches the same state precisely because the body
 * is not the truth.
 *
 * It buys three things:
 *
 *   - Out-of-order stops mattering for STATE. If a customer receives
 *     `transaction.reversed` before `transaction.posted`, reading the balance
 *     back gives the same answer either way. Only the event LOG needs
 *     ordering, and `sequence` orders that.
 *   - A duplicate delivery is free. Re-reading is idempotent by construction.
 *   - The body can never drift from the ledger, because it is not a second
 *     copy of it.
 *
 * A summary rides along anyway — amounts, the account, the description —
 * because a customer who only wants to post a Slack message should not have
 * to make an API call to do it. It is labelled as a snapshot at emit time and
 * `links` is labelled as truth.
 *
 * ===========================================================================
 * WHAT NEVER GOES IN A BODY
 * ===========================================================================
 *
 * No secret. No full account number. No card number, PAN fragment, expiry or
 * CVV. No director PII. The `data` block is built from a fixed list of
 * columns in `fromJournalEntry` below, and the list is short enough to read:
 * ids, the two dates, the entry's own classification, its description, and
 * signed integer cents. There is no passthrough of a provider payload
 * anywhere in this module, which is the mechanism that makes the rule hold
 * rather than the intention that makes it likely.
 *
 * Money is a STRING of integer cents ("-7340"), never a JSON number. The
 * ledger is `bigint` and `src/lib/ledger/db.ts` goes out of its way to stop
 * bigint silently becoming a JS number; serialising it as a float at the last
 * step would throw that away at the exact boundary where someone else's
 * parser gets to decide what it means.
 */

/** Bumped only for a breaking change to this envelope. */
export const EVENT_API_VERSION = "2026-09-10";

/**
 * The event types, and the complete mapping from a journal entry to one.
 *
 * Total by construction: `entry_type` is an enum of three and `book` is an
 * enum of two, so there are exactly six combinations and all six are named.
 * A new entry type would fail the typecheck here rather than silently
 * producing an event called `undefined`.
 */
export const EVENT_TYPES = [
  "transaction.posted",
  "transaction.reversed",
  "transaction.rebooked",
  "hold.placed",
  "hold.released",
  "hold.adjusted",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EntryType = "original" | "reversal" | "rebook";
export type Book = "financial" | "memo";

const TYPE_BY_ENTRY: Record<Book, Record<EntryType, EventType>> = {
  // The financial book is money that has actually moved.
  financial: {
    original: "transaction.posted",
    reversal: "transaction.reversed",
    rebook: "transaction.rebooked",
  },
  // The memo book is the hold model: an authorisation puts a hold on funds
  // before any money moves, and the memo entry is that hold moving. A
  // customer watching `hold.placed` is watching available balance change
  // while ledger balance does not — which is the distinction the whole
  // domain turns on, so it gets its own event family rather than being
  // flattened into `transaction.*`.
  memo: {
    original: "hold.placed",
    reversal: "hold.released",
    rebook: "hold.adjusted",
  },
};

export function eventTypeFor(book: Book, entryType: EntryType): EventType {
  return TYPE_BY_ENTRY[book][entryType];
}

/* -------------------------------------------------------------------------- */
/* The envelope                                                               */
/* -------------------------------------------------------------------------- */

export interface EnvelopeLine {
  readonly account_code: string;
  readonly account_name: string;
  /** Signed integer cents as a decimal STRING. Positive is money in for the account holder. */
  readonly amount_cents: string;
  readonly currency: string;
  readonly memo: string | null;
}

export interface EnvelopeInput {
  readonly eventId: string;
  readonly businessId: string;
  readonly eventType: EventType;
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly valueDate: string;
  readonly entryId: string;
  readonly entryType: EntryType;
  readonly book: Book;
  readonly description: string;
  readonly rail: string | null;
  readonly externalRef: string | null;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
  readonly netCents: bigint;
  readonly currency: string;
  readonly lines: readonly EnvelopeLine[];
}

/**
 * Build the body. Returns the EXACT STRING that will be signed and stored.
 *
 * Serialised here, once, and never re-serialised. `outbound_event.body` is
 * `text` rather than `jsonb` for the same reason — see 0034 §5 and
 * `src/lib/webhooks/rawbody.ts`, which measures the failure: one space of
 * difference produces a completely different signature, and the symptom is
 * that every genuine delivery is rejected while the secret looks wrong.
 */
export function buildEnvelope(input: EnvelopeInput): string {
  const account = input.lines[0];

  const body = {
    id: input.eventId,
    type: input.eventType,
    api_version: EVENT_API_VERSION,

    /** The ledger's total order. SORT ON THIS, not on arrival. */
    sequence: input.sequence.toString(),
    /** When we learned it. */
    occurred_at: input.occurredAt.toISOString(),
    /** When it happened, in book time. Different from the above after a correction. */
    value_date: input.valueDate,

    business_id: input.businessId,

    /**
     * Said in band, on every event, because a customer reads the payload and
     * not necessarily the docs — and because a promise we are not making is
     * the kind of thing that gets assumed by default.
     */
    delivery: {
      ordered: false,
      order_by: "sequence",
      note:
        "Deliveries are at-least-once and unordered. Deduplicate on `id` (also sent as the " +
        "webhook-id header) and order by `sequence`, which is this ledger's total order. " +
        "`data` is a snapshot at emit time; read `links` for authoritative current state.",
    },

    data: {
      object: "ledger_entry",
      entry_id: input.entryId,
      entry_type: input.entryType,
      book: input.book,
      rail: input.rail,
      description: input.description,
      external_ref: input.externalRef,
      /** Non-null on a reversal: the entry this one negates. Nothing is ever edited. */
      reverses_entry_id: input.reversesEntryId,
      /** Ties original + reversal + re-book together. */
      correction_group_id: input.correctionGroupId,
      /** Net effect on this business, signed integer cents as a string. */
      net_amount: { currency: input.currency, cents: input.netCents.toString() },
      accounts: input.lines,
    },

    links: {
      /**
       * Relative to the API base this endpoint was registered against. Not
       * absolutised, because this deployment has no configured public origin
       * and inventing one would produce links that 404 in exactly the
       * environment where somebody trusts them.
       */
      transactions:
        account === undefined
          ? `/api/v1/transactions?value_date_from=${input.valueDate}&value_date_to=${input.valueDate}`
          : `/api/v1/transactions?account_code=${encodeURIComponent(account.account_code)}` +
            `&value_date_from=${input.valueDate}&value_date_to=${input.valueDate}`,
      balance: account === undefined ? null : `/api/v1/accounts/${encodeURIComponent(account.account_code)}/balance`,
    },
  };

  return JSON.stringify(body);
}
