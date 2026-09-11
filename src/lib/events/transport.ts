/**
 * The one place this system makes an HTTP request to an address a customer
 * chose. Everything in `url.ts` is the policy; this is the enforcement.
 *
 * ===========================================================================
 * WHY `node:https` AND NOT `fetch`
 * ===========================================================================
 *
 * Three properties are needed and `fetch` gives away all three:
 *
 *   1. THE SOCKET MUST GO TO THE ADDRESS WE CHECKED. `fetch` resolves the
 *      hostname itself, inside undici, after our check has run. That gap is
 *      DNS rebinding: a record with a 0 TTL answers `93.184.216.34` when we
 *      validate and `169.254.169.254` when undici connects, and every textual
 *      check in the world passes. `node:https` accepts a `lookup` option, so
 *      we resolve ONCE, validate every address we got back, and then hand the
 *      connection a lookup function that can only return the address we
 *      approved. There is no second resolution to poison.
 *
 *      TLS is not weakened by this. `servername` (SNI) and certificate
 *      validation still use the hostname; only the IP the TCP connection
 *      targets is pinned. A host that cannot present a valid certificate for
 *      its own name still fails.
 *
 *   2. REDIRECTS MUST NOT BE FOLLOWED. `fetch` follows them by default, and
 *      `redirect: "manual"` is a flag someone can remove. `node:https` does
 *      not follow redirects at all — there is no option to turn on — so the
 *      safe behaviour is the only behaviour, and a 3xx becomes an ordinary
 *      delivery failure carrying a message that tells the customer to
 *      register the new URL.
 *
 *   3. THE RESPONSE MUST BE BOUNDED. An untrusted server can answer with an
 *      infinite stream. `fetch`'s body is a promise you either await whole or
 *      abandon; here we count bytes and destroy the socket at the cap.
 *
 * ===========================================================================
 * EVERY ATTEMPT SETTLES. THE QUEUE HAS ONE WORKER.
 * ===========================================================================
 *
 * `deliverOnce` awaits this function once per delivery, sequentially. A
 * promise that never settles is therefore not a slow delivery — it is every
 * later delivery for every other customer, stopped, for as long as the
 * process lives. That was a real bug in this file, measured on 2026-09-11: a
 * response over `MAX_RESPONSE_BYTES` was destroyed and then waited on for an
 * `end` event that `destroy()` had just made impossible, while `close` on the
 * request cleared the only wall-clock backstop. 40 seconds into a 10-second
 * timeout the promise was still pending, and the delivery worker with it.
 *
 * The shape that replaces it holds three rules:
 *
 *   a. Every terminal socket event settles the promise — `end`, `error` AND
 *      `close`, on both halves, because `close` is the only one that fires
 *      however the exchange ended.
 *   b. Hitting the read cap settles the promise THERE, from inside the `data`
 *      handler, rather than destroying the socket and hoping.
 *   c. A wall-clock deadline (`timeoutMs + ATTEMPT_DEADLINE_GRACE_MS`)
 *      settles the promise itself, and is cleared by settlement alone — never
 *      by a socket event, which is what made the old one cancellable by the
 *      very failure it existed for.
 *
 * An attempt that ends on (b) or (c) carries a non-null `limit`, and
 * `deliver.ts` turns that into a dead letter whose reason names the number.
 * None of this touches the request options: no redirect is enabled, and the
 * pinned `lookup` is still the only resolution that happens.
 *
 * ===========================================================================
 * WHAT A CUSTOMER'S SERVER CAN DO TO US, AND WHAT IT CANNOT
 * ===========================================================================
 *
 * It can be slow (bounded: `TIMEOUT_MS`, applied to the whole exchange, not
 * just the connect). It can be enormous (bounded: `MAX_RESPONSE_BYTES`). It
 * can be down (bounded: the retry budget in `deliver.ts`). It can lie about
 * where it is (bounded: §1 above).
 *
 * What it cannot do is reach the ledger, because nothing in this file or
 * anything it calls opens a database transaction, and because the delivery
 * worker that calls it runs after the posting has committed. See
 * `docs/EVENTS.md` §"A dead endpoint cannot stop a payment".
 */

import { request as httpsRequest } from "node:https";
import { lookup as dnsLookupCb } from "node:dns";
import type { LookupFunction } from "node:net";
import { promisify } from "node:util";

import { checkUrlText, classifyAddress, type UrlRefusal } from "./url";

const dnsLookup = promisify(dnsLookupCb);

/**
 * Ten seconds, whole exchange.
 *
 * Long enough for a cold serverless receiver on the far side of an ocean;
 * short enough that a deliberately-hanging endpoint cannot hold a worker
 * slot for a meaningful fraction of a cron tick. A hang is a failure with a
 * named reason, not a queue that stops moving.
 */
export const TIMEOUT_MS = 10_000;

/**
 * 8 KiB read, 1 KiB stored.
 *
 * We read a little of the body because an error page's first line is very
 * often the only thing that explains a 500 to the customer who wrote it, and
 * putting that in their delivery log is worth more than any other field on
 * the row. We store less than we read because the excerpt is evidence, not a
 * mirror of somebody else's server, and because `outbound_attempt` has a
 * CHECK constraint at 1024 that this must stay under.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024;
export const MAX_EXCERPT_CHARS = 1000;

/**
 * The grace on top of `timeoutMs` before the attempt is abandoned outright.
 *
 * `req.setTimeout` and the socket are the NORMAL way an attempt ends late, and
 * they end it at `timeoutMs` with a retryable failure. This is the backstop
 * underneath them, and it exists because on 2026-09-11 it was measured that
 * they can both fail to fire at all: over-cap response → `res.destroy()` →
 * `aborted` + `close` on the response, `close` on the request, no `end`, no
 * `error`, no socket left alive for `setTimeout` to fire on, and a promise that
 * stayed pending for as long as anyone was willing to wait. The delivery worker
 * awaits this promise in a sequential loop, so "pending for ever" is the whole
 * queue stopped by one customer's verbose error page.
 *
 * Two seconds, so that in the ordinary late-endpoint case the socket timeout
 * still wins and the delivery still retries; if THIS timer is what settles an
 * attempt, the transport failed to police itself and the delivery is dead
 * rather than retried, with the deadline named in the reason.
 */
export const ATTEMPT_DEADLINE_GRACE_MS = 2_000;

/**
 * Which bound an attempt hit, when it hit one.
 *
 * `null` on every ordinary outcome, including an ordinary timeout and an
 * ordinary connection failure — those retry. A non-null value is terminal:
 * `deliver.ts` dead-letters the delivery immediately instead of spending the
 * retry budget, because both of these are properties of the endpoint (or of
 * us), not weather.
 */
export type DeliveryLimit = "response_too_large" | "attempt_deadline";

export type DeliveryOutcome =
  /** A response arrived. `ok` is 2xx; anything else is a failure with a status. */
  | {
      readonly kind: "response";
      readonly ok: boolean;
      readonly status: number;
      readonly excerpt: string | null;
      readonly durationMs: number;
      readonly resolvedIp: string;
      readonly error: string | null;
      /** Non-null when a bound ended the attempt. Terminal — see `DeliveryLimit`. */
      readonly limit: DeliveryLimit | null;
    }
  /** We never got a response: refused by policy, DNS, TLS, timeout, reset. */
  | {
      readonly kind: "no_response";
      readonly error: string;
      readonly durationMs: number;
      readonly resolvedIp: string | null;
      /** Non-null when a bound ended the attempt. Terminal — see `DeliveryLimit`. */
      readonly limit: DeliveryLimit | null;
    };

export interface PostSignedOptions {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs?: number | undefined;
}

/**
 * Resolve a hostname and refuse unless EVERY address it answers with is
 * ordinary global unicast.
 *
 * `all: true` is load-bearing. Checking only the first address is the
 * multi-record bypass: a name with one public A record and one internal one
 * passes a first-address check and then connects wherever the resolver felt
 * like ordering them today.
 *
 * `verbatim: true` keeps the resolver's own ordering rather than Node's
 * v4-first re-sort, so the address we pin is the one the OS would have used.
 */
export async function resolvePublicAddress(
  hostname: string,
): Promise<{ readonly address: string; readonly family: number } | UrlRefusal> {
  let answers: { address: string; family: number }[];
  try {
    answers = (await dnsLookup(hostname, { all: true, verbatim: true })) as {
      address: string;
      family: number;
    }[];
  } catch (thrown) {
    return {
      code: "DNS_FAILED",
      message: `could not resolve '${hostname}': ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    };
  }

  if (answers.length === 0) {
    return { code: "DNS_FAILED", message: `'${hostname}' resolved to no addresses` };
  }

  for (const answer of answers) {
    const bad = classifyAddress(answer.address);
    if (bad !== null) {
      return {
        code: "ADDRESS_NOT_GLOBAL",
        message:
          `'${hostname}' resolves to ${answer.address}, which is ${bad}. ` +
          `Every address a name answers with is checked, not just the first — ` +
          `a name with one public record and one internal one is a bypass, not a coincidence.`,
      };
    }
  }

  const first = answers[0];
  if (first === undefined) {
    return { code: "DNS_FAILED", message: `'${hostname}' resolved to no addresses` };
  }
  return { address: first.address, family: first.family };
}

/**
 * POST a signed body to a customer endpoint.
 *
 * Never throws: every failure is an outcome, because the caller's job is to
 * record it on the delivery log and schedule a retry, and an exception
 * escaping into the worker loop would take the rest of the batch with it.
 */
export async function postSigned(opts: PostSignedOptions): Promise<DeliveryOutcome> {
  const started = Date.now();

  // Re-run the textual policy at SEND time, not just at registration time.
  // The URL is immutable in the database (0034's endpoint guard), so this
  // should be redundant — which is exactly why it is cheap to keep: if it
  // ever fires, something has gone wrong that we want to hear about from the
  // delivery log rather than from a customer.
  const checked = checkUrlText(opts.url);
  if (!checked.ok) {
    return {
      kind: "no_response",
      error: `refused before connecting: ${checked.error.message}`,
      durationMs: Date.now() - started,
      resolvedIp: null,
      limit: null,
    };
  }

  const resolved = await resolvePublicAddress(checked.value.hostname);
  if ("code" in resolved) {
    return {
      kind: "no_response",
      error: `refused before connecting: ${resolved.message}`,
      durationMs: Date.now() - started,
      resolvedIp: null,
      limit: null,
    };
  }

  const pinned = resolved.address;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const payload = Buffer.from(opts.body, "utf8");

  const deadlineMs = timeoutMs + ATTEMPT_DEADLINE_GRACE_MS;

  return new Promise<DeliveryOutcome>((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    /**
     * The ONLY way this promise settles, and the only place a timer is
     * cleared.
     *
     * The bug this shape replaces cleared the wall-clock timer from
     * `req.on("close")` — which fires when the socket dies, including when we
     * kill it ourselves at the read cap. The backstop was therefore reliably
     * cancelled at the exact moment it was needed. A timer that is cleared on
     * settlement instead of on a socket event cannot be cancelled by anything
     * but an answer.
     */
    const finish = (outcome: DeliveryOutcome): void => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      resolve(outcome);
    };

    let req: ReturnType<typeof httpsRequest>;
    try {
      req = httpsRequest(
        {
          protocol: "https:",
          hostname: checked.value.hostname,
          port: 443,
          path: checked.value.path === "" ? "/" : checked.value.path,
          method: "POST",
          // SNI and certificate validation use the NAME. Only the TCP target
          // is pinned.
          servername: stripBrackets(checked.value.hostname),
          headers: {
            ...opts.headers,
            "content-length": String(payload.byteLength),
            // We are not a browser and we do not want a compressed error page.
            "accept-encoding": "identity",
          },
          // THE PIN. Node calls this instead of resolving the name again, so
          // the socket can only reach the address `resolvePublicAddress`
          // approved a few microseconds ago. There is no second resolution.
          lookup: pinnedLookup(pinned, resolved.family),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let read = 0;

          res.on("data", (chunk: Buffer) => {
            read += chunk.byteLength;
            if (read <= MAX_RESPONSE_BYTES) {
              chunks.push(chunk);
              return;
            }

            // OVER THE CAP. Keep the prefix that fits, kill the socket, and
            // SETTLE HERE.
            //
            // Settling here is the fix. `res.destroy()` emits `aborted` and
            // `close` on the response and `close` on the request — it does NOT
            // emit `end` and it does NOT emit `error` — so the old code
            // destroyed the socket and then waited for an `end` event that the
            // destroy had just guaranteed would never arrive. Measured against
            // a real endpoint echoing 40 KiB: 40 seconds of a 10-second timeout
            // and still pending when the harness gave up.
            const kept = MAX_RESPONSE_BYTES - (read - chunk.byteLength);
            if (kept > 0) chunks.push(chunk.subarray(0, kept));
            res.destroy();
            finish({
              kind: "response",
              // Whatever the status line said is still a fact and still goes on
              // the attempt row. It is not a success: `limit` is what
              // `deliver.ts` branches on, and it dead-letters.
              ok: status >= 200 && status < 300,
              status,
              excerpt: excerptOf(chunks),
              durationMs: Date.now() - started,
              resolvedIp: pinned,
              limit: "response_too_large",
              error:
                `HTTP ${status} with a response body over the ${MAX_RESPONSE_BYTES}-byte read limit ` +
                `(read ${read} bytes and stopped; the socket was closed rather than drained). ` +
                `A webhook acknowledgement must be short — answer with a status and a brief body. ` +
                `This delivery was not retried, because the next attempt would read the same page.`,
            });
          });

          res.on("end", () => {
            const excerpt = excerptOf(chunks);
            const redirect = status >= 300 && status < 400;
            finish({
              kind: "response",
              // A redirect is NOT a success even though 3xx is not an error
              // status: following it would mean fetching a URL nobody checked.
              ok: status >= 200 && status < 300,
              status,
              excerpt,
              durationMs: Date.now() - started,
              resolvedIp: pinned,
              error: redirect
                ? `HTTP ${status} redirect to '${clip(res.headers.location ?? "(no Location header)")}' — ` +
                  `redirects are never followed, because a redirect is a second URL chosen by the ` +
                  `destination after our checks ran. Register the new URL as an endpoint instead.`
                : status >= 200 && status < 300
                  ? null
                  : `HTTP ${status} from ${checked.value.hostname}`,
              limit: null,
            });
          });

          res.on("error", (e: Error) => {
            finish({
              kind: "no_response",
              error: `response stream failed: ${e.message}`,
              durationMs: Date.now() - started,
              resolvedIp: pinned,
              limit: null,
            });
          });

          // `close` on the response is the catch-all under `end` and `error`:
          // it fires once, always, however the response ended — including the
          // aborts that emit neither. Guarded by `settled`, so on the ordinary
          // path (`end` then `close`) this is a no-op.
          res.on("close", () => {
            finish({
              kind: "no_response",
              error: `the connection closed after ${read} byte(s) and before the response completed`,
              durationMs: Date.now() - started,
              resolvedIp: pinned,
              limit: null,
            });
          });
        },
      );
    } catch (thrown) {
      // `https.request` can throw synchronously — a header value Node refuses,
      // for instance. This function's contract is that it NEVER throws, so an
      // exception here must not escape into the worker loop and take the rest
      // of the batch with it.
      finish({
        kind: "no_response",
        error: `request could not be created: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        durationMs: Date.now() - started,
        resolvedIp: pinned,
        limit: null,
      });
      return;
    }

    // One timeout for the whole exchange. `setTimeout` on the request fires
    // on socket inactivity, which a trickling server can dodge for ever, so
    // there is also a hard wall-clock deadline below.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`no response within ${timeoutMs}ms`));
    });

    // THE BACKSTOP. It settles the promise itself rather than destroying the
    // socket and trusting an event to follow — that trust is exactly what
    // failed. It is cleared only by `finish`, never by a socket event, so
    // nothing that happens on the wire can cancel it; and because `finish`
    // always clears it, it cannot hold a serverless invocation open either
    // (which is what the old `unref` was for). Not armed at all if the attempt
    // has somehow already settled by this line — a timer with nothing left to
    // catch would only hold the process open for its own duration.
    if (!settled) {
      deadline = setTimeout(() => {
        req.destroy(new Error(`exchange exceeded ${deadlineMs}ms`));
        finish({
          kind: "no_response",
          error:
            `attempt abandoned: it exceeded the ${deadlineMs}ms hard deadline ` +
            `(${timeoutMs}ms exchange timeout + ${ATTEMPT_DEADLINE_GRACE_MS}ms grace) without ` +
            `producing any outcome. The socket was destroyed and the delivery worker released.`,
          durationMs: Date.now() - started,
          resolvedIp: pinned,
          limit: "attempt_deadline",
        });
      }, deadlineMs);
    }

    req.on("error", (e: Error) => {
      finish({
        kind: "no_response",
        error: `${e.message} (connecting to ${pinned})`,
        durationMs: Date.now() - started,
        resolvedIp: pinned,
        limit: null,
      });
    });

    // `close` on the request is the same catch-all as on the response, for
    // the half of the exchange that has no response yet. It used to clear the
    // backstop and settle nothing, which is how one oversized body stopped
    // the queue.
    req.on("close", () => {
      finish({
        kind: "no_response",
        error: `the connection to ${pinned} closed before any response arrived`,
        durationMs: Date.now() - started,
        resolvedIp: pinned,
        limit: null,
      });
    });

    req.end(payload);
  });
}

/**
 * A `lookup` that ignores the hostname and answers with one pre-approved
 * address.
 *
 * This is the whole DNS-rebinding defence in four lines. Node's `net` module
 * calls the `lookup` option instead of `dns.lookup`, so there is no second
 * resolution between our check and the SYN packet — the address the socket
 * targets is, by construction, the address `resolvePublicAddress` validated.
 *
 * It answers both calling conventions because Node picks between them based
 * on `options.all`, and getting that wrong produces a connection error rather
 * than a bypass — but a connection error on every delivery is its own kind of
 * outage.
 */
function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    const wantsAll = typeof options === "object" && options !== null && options.all === true;
    if (wantsAll) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function excerptOf(chunks: readonly Buffer[]): string | null {
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks as Buffer[])
    .toString("utf8")
    // One line. A stack trace split across lines does not survive a log
    // drain, and it does not survive a table cell either.
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;
  return text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS - 3)}...`;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function clip(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}
