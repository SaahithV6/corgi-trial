/**
 * The dimensions a settlement is priced on, read off the provider's own
 * payload and from nothing else.
 *
 * ─── What the Lithic event data ACTUALLY carries ────────────────────────────
 *
 * Measured against every `card_transaction.updated` payload in `webhook_inbox`
 * on this book (378 rows) before a line of the rate card was designed, because
 * "do not invent a dimension you cannot populate from a real event" is only a
 * rule if you go and look first:
 *
 *   merchant.mcc             PRESENT and VARIED — 100+ distinct four-digit
 *                            codes. 5542 (automated fuel dispensers) dominates
 *                            at 341 of the payloads, because the brief's own
 *                            fuel-pump scenario is what generated most of this
 *                            traffic; 5812 (eating places), 5814 (fast food)
 *                            and a long tail of others follow. This is the
 *                            dimension that does real work on this book.
 *
 *   pos.entry_mode.pan       PRESENT on every payload, and CONSTANT: 'MANUAL'.
 *   pos.terminal.type        PRESENT and constant: 'PHONE'.
 *   pos.terminal.attended    PRESENT and constant: false.
 *                            Together that is a keyed phone order, which is
 *                            card-NOT-present. The field is real, it is read,
 *                            and the sandbox never varies it — so the
 *                            card-present arm of the rate card ships correct
 *                            and unexercised, and this comment says so rather
 *                            than the screen implying otherwise. Lithic's
 *                            simulate endpoints accept `mcc` and the merchant
 *                            acceptor fields; they do NOT accept a POS entry
 *                            mode, so there is no way to make this vary from
 *                            our side. Measured, not assumed.
 *
 *   network                  PRESENT and constant: 'VISA'.
 *   merchant.country         PRESENT and constant: 'USA'.
 *                            BOTH ARE DELIBERATELY NOT RATE-CARD DIMENSIONS.
 *                            A dimension with one observed value is a dimension
 *                            you cannot demonstrate, and a rate card keyed on
 *                            one would be three columns of decoration. They are
 *                            recorded on the posting as EVIDENCE — so the row
 *                            says what it was priced against — and the rate
 *                            card does not join on them.
 *
 *   acquirer_fee             PRESENT and always 0 in this sandbox.
 *
 * ─── The dimension that is NOT here, and why ────────────────────────────────
 *
 * CARD PRODUCT. Real interchange varies by product — consumer credit, business
 * credit, regulated debit under Durbin — and it would be the natural third
 * dimension. It is not built, because it is not in the event: Lithic carries
 * the product on the CARD object (`type`, `card_program_token`), our own `card`
 * table stores `last_four` and `nickname` and nothing else, and every card on
 * this book was created by the same call with the same defaults. Populating it
 * would mean inventing a product per card and then pricing against the
 * invention. Named as a gap in `docs/INTERCHANGE.md` instead.
 *
 * ─── Purity ─────────────────────────────────────────────────────────────────
 *
 * No database, no clock, no I/O. The input is one provider payload — the same
 * object whether it arrived as a live webhook or is being re-read out of
 * `webhook_inbox` for a backfill — so the booking path and the backfill path
 * derive dimensions by the same function and cannot disagree about what a
 * transaction was.
 */

import type { Presentment } from "./rate-card";

/** What we read off one transaction, before the rate card is consulted. */
export interface SettlementDimensions {
  /**
   * The merchant category code, four digits, verbatim.
   *
   * `null` when the payload carried none. That is "we were not told", which is
   * a different claim from "it was 0000", and it resolves to the DEFAULT
   * category rather than blocking the pricing — we have the provider's own
   * record of the transaction, so it settled and it earned something.
   */
  readonly mcc: string | null;
  readonly presentment: Presentment;
  /** `pos.entry_mode.pan` verbatim, as the evidence for `presentment`. */
  readonly entryMode: string | null;
  /** `pos.terminal.type` verbatim. Evidence only; nothing branches on it. */
  readonly terminalType: string | null;
  /** `network` verbatim. Evidence only — see the header. */
  readonly network: string | null;
  /** `merchant.descriptor`, for a human reading the economics screen. */
  readonly descriptor: string | null;
}

/**
 * PAN entry modes where the card itself was physically read.
 *
 * These are the network's own vocabulary, not ours. A value not in either list
 * — including `UNKNOWN`, `UNSPECIFIED` and anything Lithic adds tomorrow —
 * falls through to `unknown` and is priced at the card-present (lower) rate.
 * Defaulting an unrecognised mode into the HIGHER card-not-present rate would
 * mean a provider shipping a new enum value silently increased our reported
 * revenue, which is the wrong direction for a surprise.
 */
const CARD_PRESENT_ENTRY_MODES: ReadonlySet<string> = new Set([
  "CONTACTLESS",
  "ICC",
  "MAGNETIC_STRIPE",
  "ERROR_MAGNETIC_STRIPE",
  "BAR_CODE",
  "OCR",
  "AUTO_ENTRY",
  "SECURE_CARDLESS",
]);

/**
 * PAN entry modes where the number arrived without the card.
 *
 * `MANUAL` and `KEY_ENTERED` are here and it is worth stating why, because it
 * is the arm this sandbox actually exercises and the one a reviewer will point
 * at: a hand-keyed PAN is card-NOT-present for interchange even when a human
 * was standing at a physical terminal, because the card was never read and none
 * of the authentication that makes card-present cheap took place. The network
 * prices the entry mode, not the furniture.
 */
const CARD_NOT_PRESENT_ENTRY_MODES: ReadonlySet<string> = new Set([
  "MANUAL",
  "KEY_ENTERED",
  "ERROR_KEYED",
  "ECOMMERCE",
  "CREDENTIAL_ON_FILE",
]);

/** `presentment` from one PAN entry mode. Total, and pure. */
export function presentmentOf(entryMode: string | null): Presentment {
  if (entryMode === null) return "unknown";
  const mode = entryMode.trim().toUpperCase();
  if (CARD_PRESENT_ENTRY_MODES.has(mode)) return "card_present";
  if (CARD_NOT_PRESENT_ENTRY_MODES.has(mode)) return "card_not_present";
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string at `key`, or `null`. Never `""`, never a number. */
function text(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null;
  const raw = source[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Read the dimensions off one Lithic transaction payload.
 *
 * Typed `unknown` rather than `Transaction` on purpose. `Transaction.merchant`
 * and `Transaction.pos` are declared `Record<string, unknown>` in the rail
 * adapter — deliberately, because Lithic's own shapes there are wide and
 * change — so the type buys nothing here and pretending otherwise would push a
 * cast into every call site. The backfill reads the same JSON straight out of
 * `webhook_inbox`, and it must go through this exact function.
 *
 * Everything is defensive and nothing throws: a payload missing a block yields
 * `null` for that field and `unknown` for the presentment, which are both
 * priceable states. A settlement is never refused a price because a provider
 * omitted a descriptor.
 */
export function readDimensions(payload: unknown): SettlementDimensions {
  const txn = asRecord(payload);
  const merchant = asRecord(txn?.["merchant"]);
  const pos = asRecord(txn?.["pos"]);
  const entryModeBlock = asRecord(pos?.["entry_mode"]);
  const terminal = asRecord(pos?.["terminal"]);

  const mccRaw = text(merchant, "mcc");
  // Four digits or nothing. Lithic sends `'4860'`; anything else is a shape we
  // have not seen and must not silently join to a category table on.
  const mcc = mccRaw !== null && /^[0-9]{4}$/.test(mccRaw) ? mccRaw : null;
  const entryMode = text(entryModeBlock, "pan");

  return {
    mcc,
    presentment: presentmentOf(entryMode),
    entryMode,
    terminalType: text(terminal, "type"),
    network: text(txn, "network"),
    descriptor: text(merchant, "descriptor"),
  };
}

/**
 * Is this payload a provider record we can price at all?
 *
 * TRUE when the payload carries a `merchant` or a `pos` block — i.e. when it is
 * a real transaction record the network actually sent us. FALSE for a payload
 * with neither, which on this book means a synthetic authorisation built by an
 * integration test (`auth-1789059056109-2`) that never had a merchant because
 * it never had a merchant.
 *
 * This is the line the brief draws, enforced at the posting boundary rather
 * than only at design time: **we price what the provider told us, and we do not
 * invent a merchant for a transaction that never had one.** Settlements on the
 * wrong side of it are not silently skipped — `v_interchange_unpriced` lists
 * every one of them with the reason, which is the same "park, never guess"
 * discipline `resolveCard()` and `resolveEventSemanticsBatch()` already use.
 */
export function isPriceable(payload: unknown): boolean {
  const txn = asRecord(payload);
  if (txn === null) return false;
  return asRecord(txn["merchant"]) !== null || asRecord(txn["pos"]) !== null;
}
