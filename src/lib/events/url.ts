/**
 * What we refuse to fetch, and why.
 *
 * ===========================================================================
 * THE SHAPE OF THE PROBLEM
 * ===========================================================================
 *
 * A customer types a URL and our server makes an HTTP request to it. That
 * sentence is the definition of server-side request forgery. The server is
 * inside a trust boundary the customer is not: it can reach the cloud
 * metadata service, the database, the internal admin surfaces, the Neon
 * pooler, and every other service on the deploy's network that believed
 * "only our own code can reach me" was an access control.
 *
 * This is the SECOND time this class has appeared in this repository today —
 * the earlier one was a header-controlled fetch that let a caller choose which
 * host the server called. That one was a bug. This one is a FEATURE REQUEST:
 * the whole point of an outbound webhook is that the destination is
 * attacker-controlled by design. So it cannot be fixed by removing the
 * capability; it has to be fenced.
 *
 * ===========================================================================
 * THE FENCE, IN ORDER, AND THE ARGUMENT FOR EACH BAR
 * ===========================================================================
 *
 *  1. HTTPS ONLY. `http:` is refused, and so is every other scheme —
 *     `file:`, `gopher:`, `ftp:`, `data:`, `blob:`, `redis:`. Two separate
 *     reasons and either alone is sufficient. (a) Confidentiality: the body is
 *     a customer's transaction history and the headers carry a signature; in
 *     clear text both are readable by every hop. (b) `http:` is the scheme of
 *     every classic SSRF pivot into a plaintext internal protocol, because
 *     enough of them will parse an HTTP request as a command stream.
 *     Enforced twice: here, and as a CHECK constraint in migration 0034, in
 *     the one place an application bug cannot route around.
 *
 *  2. PORT 443 ONLY. This is the bar most people leave out and it is the one
 *     that turns a webhook sender into a port scanner. A delivery attempt
 *     reports, in the customer's own delivery log, whether a connection
 *     succeeded, was refused, or hung — for any host:port they choose. That
 *     is a network-mapping oracle with a UI. Restricting to 443 does not make
 *     scanning impossible (DNS still points where the customer says) but it
 *     collapses the port axis entirely, and every real webhook receiver on the
 *     public internet listens on 443.
 *
 *  3. NO CREDENTIALS IN THE URL. `https://evil.example@internal.svc/` is a
 *     URL whose host is `internal.svc`, and it is read as `evil.example` by
 *     roughly every human and a depressing number of parsers. Refusing
 *     userinfo outright removes a whole family of validator-vs-fetcher
 *     disagreements. (`URL` gets this right; the reviewer reading the
 *     delivery log does not.)
 *
 *  4. NO HOSTNAME THAT IS NOT A PUBLIC NAME. `localhost`, anything ending
 *     `.localhost`, `.local`, `.internal`, `.home.arpa`, `.onion`, and any
 *     single-label host (`db`, `metadata`, `redis`) are refused before DNS is
 *     consulted at all. A single-label name resolves through the deploy's own
 *     search domain, which is exactly the internal namespace we are fencing
 *     off, and the answer differs per environment — so "it was fine in CI" is
 *     not evidence about production.
 *
 *  5. EVERY RESOLVED ADDRESS MUST BE GLOBAL UNICAST. This is the bar that
 *     actually holds, because bars 1–4 are all about the string and DNS is
 *     what decides where the packet goes. `evil.example` with an A record of
 *     `169.254.169.254` passes every textual check ever written. So we
 *     resolve the name ourselves, and refuse if ANY returned address is
 *     loopback, private, link-local, carrier-grade NAT, multicast,
 *     broadcast, reserved, documentation, benchmarking, or unspecified — in
 *     v4 or v6, including the v6 spellings of v4 addresses (`::ffff:127.0.0.1`,
 *     the NAT64 prefix `64:ff9b::/96`, and 6to4 `2002::/16`), which exist
 *     precisely to make a v4 address arrive wearing a v6 coat.
 *
 *     ANY, not "the one we picked". A name with two A records, one public and
 *     one internal, is a rebinding attack that does not even need timing.
 *
 *  6. THE CONNECTION GOES TO THE ADDRESS WE CHECKED. Validating a name and
 *     then handing the name to a fetch library re-resolves it, and the window
 *     between those two resolutions is the DNS-rebinding attack: a 0-TTL
 *     record answers public on the check and internal on the connect. So
 *     `transport.ts` passes a `lookup` function to `node:https` that returns
 *     the pinned address from THIS validation and nothing else. The socket
 *     cannot go anywhere the check did not approve. SNI and certificate
 *     validation still use the hostname, so TLS is not weakened.
 *
 *  7. NO REDIRECTS, EVER. A redirect is a second URL, chosen by the
 *     destination, after every check above has run. Following one — even
 *     "just to https" — hands the attacker a validated request aimed wherever
 *     they like, which is the whole fence undone by one `Location` header.
 *     `node:https` does not follow redirects on its own; `transport.ts` treats
 *     any 3xx as a delivery failure whose dead-letter message says so, so a
 *     customer who genuinely moved their endpoint is told to register the new
 *     URL rather than left wondering.
 *
 * ===========================================================================
 * WHAT THIS COSTS, STATED PLAINLY
 * ===========================================================================
 *
 * A developer cannot point an endpoint at `localhost:3000` or at an ngrok-
 * style HTTP tunnel, and that is a real inconvenience which will be asked
 * about. The answer is that the exemption people reach for — "allow loopback
 * in development" — is a flag that is one environment-variable mistake away
 * from being on in production, and the thing it protects is the deployment's
 * entire internal network. Local development uses a real HTTPS receiver;
 * everything else is a bypass with a friendly name.
 *
 * There is DELIBERATELY NO ALLOWLIST ESCAPE HATCH IN THIS FILE. Not a
 * per-endpoint "trusted" boolean, not an env var. If one is ever needed it
 * should be a separate, loudly-named module that a reviewer trips over.
 */

import { isIP } from "node:net";

import { err, ok, type Result } from "@/lib/result";

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A refusal names the thing that was wrong. Not "invalid URL" — that is the
 * message the inbound dead-letter used to carry, and the reason nobody could
 * act on it.
 */
export type UrlRefusal = {
  readonly code: UrlRefusalCode;
  readonly message: string;
};

export type UrlRefusalCode =
  | "UNPARSEABLE"
  | "SCHEME_NOT_HTTPS"
  | "PORT_NOT_443"
  | "CREDENTIALS_IN_URL"
  | "FRAGMENT_IN_URL"
  | "HOSTNAME_NOT_PUBLIC"
  | "ADDRESS_NOT_GLOBAL"
  | "DNS_FAILED";

const refuse = (code: UrlRefusalCode, message: string): Result<never, UrlRefusal> =>
  err({ code, message });

/** A URL that has passed every check that can be made without DNS. */
export interface CheckedUrl {
  readonly href: string;
  readonly hostname: string;
  readonly path: string;
}

/* -------------------------------------------------------------------------- */
/* 1. The textual checks                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hostname suffixes that never name something on the public internet.
 *
 * `.local` is mDNS, `.internal` is the conventional private zone (and GCP's
 * metadata zone), `.home.arpa` is the reserved home-network zone, `.onion`
 * is Tor and cannot be reached over ordinary DNS anyway.
 */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".onion"];

const PRIVATE_EXACT = new Set(["localhost", "local", "internal"]);

export function checkUrlText(raw: string): Result<CheckedUrl, UrlRefusal> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("UNPARSEABLE", `not a URL: ${clip(raw)}`);
  }

  if (url.protocol !== "https:") {
    return refuse(
      "SCHEME_NOT_HTTPS",
      `scheme is '${url.protocol.replace(":", "")}'; only https is delivered to. ` +
        `The body is your transaction history and the headers carry its signature; ` +
        `neither goes on the wire in clear.`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    return refuse(
      "CREDENTIALS_IN_URL",
      "the URL carries userinfo (user:password@host). The host of such a URL is not " +
        "what it looks like, so it is refused rather than interpreted. Put credentials " +
        "in a query parameter or a path segment you can rotate.",
    );
  }

  // A fragment is never sent to the server, so a URL carrying one has a piece
  // the author believes is load-bearing and is not. Cheaper to refuse than to
  // silently drop.
  if (url.hash !== "") {
    return refuse("FRAGMENT_IN_URL", "the URL carries a #fragment, which is never transmitted. Remove it.");
  }

  // `url.port` is "" when the port is the scheme default (443).
  if (url.port !== "" && url.port !== "443") {
    return refuse(
      "PORT_NOT_443",
      `port ${url.port} is refused; deliveries go to 443 only. A delivery attempt ` +
        `reports whether a connection succeeded, was refused, or hung, so an arbitrary ` +
        `port would make this a port scanner with a delivery log for output.`,
    );
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (host === "") {
    return refuse("HOSTNAME_NOT_PUBLIC", "the URL has no host");
  }

  // Bracketed IPv6 literals arrive from `URL` as `[::1]`.
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (isIP(literal) !== 0) {
    // An IP literal skips DNS, so its check happens here rather than later.
    const bad = classifyAddress(literal);
    if (bad !== null) {
      return refuse("ADDRESS_NOT_GLOBAL", `${literal} is ${bad}`);
    }
    return ok({ href: url.toString(), hostname: url.hostname, path: `${url.pathname}${url.search}` });
  }

  if (PRIVATE_EXACT.has(host) || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    return refuse(
      "HOSTNAME_NOT_PUBLIC",
      `'${host}' is not a public name — it resolves inside a private namespace, ` +
        `and which one depends on where this process happens to be running.`,
    );
  }

  if (!host.includes(".")) {
    return refuse(
      "HOSTNAME_NOT_PUBLIC",
      `'${host}' is a single-label name. It resolves through this deployment's own ` +
        `search domain, which is the internal namespace this check exists to keep out.`,
    );
  }

  return ok({ href: url.toString(), hostname: url.hostname, path: `${url.pathname}${url.search}` });
}

/* -------------------------------------------------------------------------- */
/* 2. Address classification                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Returns a human phrase naming what is wrong with this address, or `null`
 * when it is ordinary global unicast.
 *
 * Written out as explicit ranges rather than pulled from a package, because
 * this list IS the security decision and it has to be readable line by line.
 * Each entry is an RFC with a reason, not a number someone copied.
 */
export function classifyAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return classifyV4(parseV4(address));
  if (family === 6) return classifyV6(address);
  return "not an IP address";
}

function parseV4(address: string): readonly number[] {
  return address.split(".").map((part) => Number(part));
}

function classifyV4(o: readonly number[]): string | null {
  const a = o[0] ?? 0;
  const b = o[1] ?? 0;

  // RFC 1122 "this network" — and 0.0.0.0, which on many stacks means
  // "every local interface".
  if (a === 0) return "in 0.0.0.0/8 (this-network / unspecified)";
  // RFC 1122 loopback. The whole /8, not just 127.0.0.1: 127.1 and
  // 127.0.0.2 are the same machine and are how this check is usually evaded.
  if (a === 127) return "loopback (127.0.0.0/8) — that is this server";
  // RFC 1918 private.
  if (a === 10) return "a private address (10.0.0.0/8, RFC 1918)";
  if (a === 172 && b >= 16 && b <= 31) return "a private address (172.16.0.0/12, RFC 1918)";
  if (a === 192 && b === 168) return "a private address (192.168.0.0/16, RFC 1918)";
  // RFC 6598 carrier-grade NAT — routable inside a provider's network.
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT space (100.64.0.0/10, RFC 6598)";
  // RFC 3927 link-local. 169.254.169.254 is the cloud metadata service on
  // AWS, GCP and Azure, and it hands out credentials to whoever asks.
  if (a === 169 && b === 254) return "link-local (169.254.0.0/16) — this range contains the cloud metadata service";
  // RFC 6890 IETF protocol assignments, includes 192.0.0.8 and friends.
  if (a === 192 && b === 0 && (o[2] ?? 0) === 0) return "IETF protocol assignment space (192.0.0.0/24)";
  // RFC 5737 documentation ranges — never routable, so a delivery here is a
  // misconfiguration we can name instead of a timeout the customer debugs.
  if (a === 192 && b === 0 && (o[2] ?? 0) === 2) return "documentation space (192.0.2.0/24, RFC 5737)";
  if (a === 198 && b === 51 && (o[2] ?? 0) === 100) return "documentation space (198.51.100.0/24, RFC 5737)";
  if (a === 203 && b === 0 && (o[2] ?? 0) === 113) return "documentation space (203.0.113.0/24, RFC 5737)";
  // RFC 3068 6to4 relay anycast.
  if (a === 192 && b === 88 && (o[2] ?? 0) === 99) return "6to4 relay anycast (192.88.99.0/24)";
  // RFC 2544 benchmarking — used for inter-network test rigs.
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking space (198.18.0.0/15, RFC 2544)";
  // RFC 5771 multicast, and RFC 1112 reserved (which contains 255.255.255.255).
  if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
  if (a >= 240) return "reserved space (240.0.0.0/4), including the broadcast address";

  return null;
}

/**
 * IPv6, expanded to sixteen bytes first.
 *
 * The v4-in-v6 cases are the interesting ones and they are the reason this
 * cannot be a prefix-string comparison: `::ffff:127.0.0.1`, `::ffff:7f00:1`
 * and `0:0:0:0:0:ffff:7f00:0001` are the same address written three ways, and
 * all three are loopback.
 */
function classifyV6(address: string): string | null {
  const bytes = expandV6(address);
  if (bytes === null) return "an unparseable IPv6 address";

  const be = (i: number): number => bytes[i] ?? 0;
  const allZeroThrough = (n: number): boolean => bytes.slice(0, n).every((x) => x === 0);

  // ::1 loopback, :: unspecified.
  if (allZeroThrough(15) && be(15) === 1) return "IPv6 loopback (::1) — that is this server";
  if (allZeroThrough(16)) return "the unspecified address (::)";

  // ::ffff:0:0/96 — IPv4-mapped. Unwrap and apply the v4 rules, which is the
  // whole point: this is how a v4 private address arrives dressed as v6.
  if (allZeroThrough(10) && be(10) === 0xff && be(11) === 0xff) {
    const v4 = `${be(12)}.${be(13)}.${be(14)}.${be(15)}`;
    const bad = classifyV4(parseV4(v4));
    return bad === null ? null : `an IPv4-mapped address (${v4}) that is ${bad}`;
  }

  // ::/96 IPv4-compatible (deprecated) — refuse the whole block; nothing
  // legitimate uses it and it is another v4 smuggling shape.
  if (allZeroThrough(12)) return "a deprecated IPv4-compatible address (::/96)";

  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64. The last four bytes are a v4
  // address that the translator will actually deliver to.
  if (be(0) === 0x00 && be(1) === 0x64 && be(2) === 0xff && be(3) === 0x9b) {
    const v4 = `${be(12)}.${be(13)}.${be(14)}.${be(15)}`;
    return `a NAT64 address (64:ff9b::/96) wrapping ${v4}`;
  }

  // 2002::/16 — 6to4, bytes 2..5 are the embedded v4. Refused outright: the
  // relay infrastructure is deprecated and the embedded address is chosen by
  // whoever wrote the AAAA record.
  if (be(0) === 0x20 && be(1) === 0x02) return "a 6to4 address (2002::/16) wrapping an IPv4 address";

  // 100::/64 — RFC 6666 discard prefix.
  if (be(0) === 0x01 && be(1) === 0x00 && allZeroThroughFrom(bytes, 2, 8)) return "the discard prefix (100::/64)";

  // 2001:db8::/32 — documentation.
  if (be(0) === 0x20 && be(1) === 0x01 && be(2) === 0x0d && be(3) === 0xb8) return "documentation space (2001:db8::/32)";

  // fc00::/7 — unique local (the v6 RFC 1918).
  if ((be(0) & 0xfe) === 0xfc) return "a unique-local address (fc00::/7) — the IPv6 private range";

  // fe80::/10 — link-local.
  if (be(0) === 0xfe && (be(1) & 0xc0) === 0x80) return "IPv6 link-local (fe80::/10)";

  // ff00::/8 — multicast.
  if (be(0) === 0xff) return "IPv6 multicast (ff00::/8)";

  return null;
}

function allZeroThroughFrom(bytes: readonly number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if ((bytes[i] ?? 0) !== 0) return false;
  return true;
}

/** `::ffff:127.0.0.1` -> 16 bytes. Returns null if it will not parse. */
export function expandV6(address: string): number[] | null {
  let text = address;

  // A trailing dotted quad is the v4 tail of a mapped/compatible address.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const after = text.slice(lastColon + 1);
  if (after.includes(".")) {
    if (isIP(after) !== 4) return null;
    tail = [...parseV4(after)];
    text = `${text.slice(0, lastColon + 1)}0:0`;
    // Replace the quad with two zero groups; the actual bytes go back on at
    // the end, below.
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;

  const groups: number[] =
    halves.length === 2
      ? [...head, ...new Array<number>(Math.max(0, 8 - head.length - rest.length)).fill(0), ...rest]
      : head;

  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >> 8) & 0xff, g & 0xff);
  }
  if (tail.length === 4) {
    bytes[12] = tail[0] ?? 0;
    bytes[13] = tail[1] ?? 0;
    bytes[14] = tail[2] ?? 0;
    bytes[15] = tail[3] ?? 0;
  }
  return bytes;
}

function clip(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}
