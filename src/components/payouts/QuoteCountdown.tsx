"use client";

import { useEffect, useState } from "react";

/**
 * The countdown on a live offer.
 *
 * ── WHY THIS IS THE ONLY CLIENT COMPONENT ON THE SCREEN ─────────────────────
 *
 * An expiry that is only visible on reload is not an expiry a person can watch
 * happen, and watching it happen is the whole demonstration. So this ticks.
 *
 * ── WHAT IT IS CAREFUL NOT TO DO ────────────────────────────────────────────
 *
 * IT IS NOT THE EXPIRY. It renders one; it does not decide one. The decision
 * is `fx_quote_acceptance_guard()` in the database, which reads the quote's
 * own `expires_at` against the transaction clock and refuses the INSERT. This
 * component and that trigger can disagree — a browser clock can be minutes out
 * — and when they do, THE DATABASE IS RIGHT. That is why the accept button is
 * never disabled by this number: a greyed-out button demonstrates nothing and
 * a client-side clock is not a control. Pressing it on a lapsed offer sends a
 * real request and gets a real refusal with a real code, which is the most
 * instructive thing this screen can show.
 *
 * IT PERFORMS NO ARITHMETIC ON MONEY. Every figure on this screen is a string
 * the server formatted. Seconds are not cents.
 *
 * IT DOES NOT RENDER A DIFFERENT FIRST FRAME THAN THE SERVER DID. The initial
 * state is the server's own `expiresInSeconds`, so hydration matches; the
 * interval starts afterwards, in the effect.
 */
export function QuoteCountdown({
  expiresAt,
  initialSeconds,
  ttlSeconds,
}: {
  readonly expiresAt: string;
  /** The server's own reading, so the first frame matches the server's. */
  readonly initialSeconds: number;
  /** The full life of the offer, for the bar. */
  readonly ttlSeconds: number;
}) {
  const [remaining, setRemaining] = useState(initialSeconds);

  useEffect(() => {
    const deadline = Date.parse(expiresAt);
    if (Number.isNaN(deadline)) return;

    const tick = () => setRemaining(Math.floor((deadline - Date.now()) / 1000));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const expired = remaining <= 0;
  const seconds = Math.max(0, remaining);
  const minutes = Math.floor(seconds / 60);
  const label = expired
    ? "expired"
    : minutes > 0
      ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
      : `${seconds}s`;

  // Clamped both ways: a clock that is ahead would otherwise draw a negative
  // width, and one that is behind a bar past its own container.
  const fraction = ttlSeconds <= 0 ? 0 : Math.min(1, Math.max(0, seconds / ttlSeconds));

  return (
    <div className="flex items-center gap-3">
      <span
        className={`money text-sm tabular-nums ${expired ? "money-negative" : ""}`}
        aria-live="off"
      >
        {label}
      </span>
      <span
        className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-raised"
        role="img"
        aria-label={
          expired
            ? "This offer has expired. Accepting it will be refused by the database."
            : `This offer stands for about ${seconds} more seconds.`
        }
      >
        <span
          className={`block h-full rounded-full ${expired ? "bg-negative" : "bg-text"}`}
          style={{ width: `${fraction * 100}%` }}
        />
      </span>
    </div>
  );
}
