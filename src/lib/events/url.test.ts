import { describe, expect, it } from "vitest";

import { checkUrlText, classifyAddress, expandV6 } from "./url";

/**
 * The fence, exercised.
 *
 * A refusal list nobody has watched refuse anything is a comment, which is
 * the same argument `dbcheck.mjs` makes about an invariant view that cannot
 * fail. Every bar in `url.ts`'s header has at least one case here, and the
 * v4-in-v6 spellings have several, because those are the ones a textual check
 * misses.
 */

const refusalOf = (url: string): string => {
  const r = checkUrlText(url);
  if (r.ok) throw new Error(`expected refusal, got ok: ${url}`);
  return r.error.code;
};

describe("scheme", () => {
  it("accepts https", () => {
    expect(checkUrlText("https://hooks.example.com/corgi").ok).toBe(true);
  });

  it.each([
    "http://hooks.example.com/corgi",
    "ftp://hooks.example.com/",
    "file:///etc/passwd",
    "gopher://example.com:70/_x",
    "redis://example.com:6379",
  ])("refuses %s", (url) => {
    expect(refusalOf(url)).toBe("SCHEME_NOT_HTTPS");
  });

  it("refuses a data: URL", () => {
    expect(refusalOf("data:text/plain,hello")).toBe("SCHEME_NOT_HTTPS");
  });
});

describe("port", () => {
  it("accepts the implicit 443 and the explicit one", () => {
    expect(checkUrlText("https://hooks.example.com/x").ok).toBe(true);
    expect(checkUrlText("https://hooks.example.com:443/x").ok).toBe(true);
  });

  it.each(["https://hooks.example.com:8443/x", "https://hooks.example.com:22/x", "https://hooks.example.com:5432/x"])(
    "refuses %s — an arbitrary port makes this a port scanner",
    (url) => {
      expect(refusalOf(url)).toBe("PORT_NOT_443");
    },
  );
});

describe("the URL string itself", () => {
  it("refuses userinfo, because the host is not what it looks like", () => {
    // Reads as evil.example to a human. The host is internal.svc.
    expect(refusalOf("https://evil.example@internal.svc/hook")).toBe("CREDENTIALS_IN_URL");
    expect(refusalOf("https://user:pass@hooks.example.com/hook")).toBe("CREDENTIALS_IN_URL");
  });

  it("refuses a fragment, which is never transmitted", () => {
    expect(refusalOf("https://hooks.example.com/hook#token")).toBe("FRAGMENT_IN_URL");
  });

  it("refuses garbage", () => {
    expect(refusalOf("not a url")).toBe("UNPARSEABLE");
  });
});

describe("hostnames that are not public names", () => {
  it.each([
    "https://localhost/hook",
    "https://LOCALHOST/hook",
    "https://api.localhost/hook",
    "https://printer.local/hook",
    "https://metadata.internal/hook",
    "https://router.home.arpa/hook",
    "https://abcdefg.onion/hook",
  ])("refuses %s", (url) => {
    expect(refusalOf(url)).toBe("HOSTNAME_NOT_PUBLIC");
  });

  it("refuses a single-label host — it resolves in the deploy's own search domain", () => {
    expect(refusalOf("https://db/hook")).toBe("HOSTNAME_NOT_PUBLIC");
    expect(refusalOf("https://metadata/hook")).toBe("HOSTNAME_NOT_PUBLIC");
  });

  it("refuses a trailing-dot localhost", () => {
    expect(refusalOf("https://localhost./hook")).toBe("HOSTNAME_NOT_PUBLIC");
  });
});

describe("IP literals", () => {
  it.each([
    "https://127.0.0.1/hook",
    // The evasion people actually use: still 127/8.
    "https://127.1.2.3/hook",
    "https://0.0.0.0/hook",
    "https://10.1.2.3/hook",
    "https://172.16.0.9/hook",
    "https://172.31.255.254/hook",
    "https://192.168.1.1/hook",
    // AWS/GCP/Azure metadata. Hands out credentials to whoever asks.
    "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/hook",
    "https://198.18.0.1/hook",
    "https://224.0.0.1/hook",
    "https://255.255.255.255/hook",
    "https://[::1]/hook",
    "https://[fe80::1]/hook",
    "https://[fc00::1]/hook",
    "https://[fd00::1]/hook",
    "https://[ff02::1]/hook",
    // v4 wearing a v6 coat. Every one of these is loopback or private.
    "https://[::ffff:127.0.0.1]/hook",
    "https://[::ffff:7f00:1]/hook",
    "https://[::ffff:10.0.0.1]/hook",
    "https://[64:ff9b::127.0.0.1]/hook",
    "https://[2002:7f00:0001::]/hook",
  ])("refuses %s", (url) => {
    expect(refusalOf(url)).toBe("ADDRESS_NOT_GLOBAL");
  });

  it("allows an ordinary public literal", () => {
    expect(checkUrlText("https://93.184.216.34/hook").ok).toBe(true);
    expect(checkUrlText("https://[2606:2800:220:1:248:1893:25c8:1946]/hook").ok).toBe(true);
  });

  it("172.15 and 172.32 are NOT private — the /12 boundary is not the whole /8", () => {
    expect(classifyAddress("172.15.0.1")).toBeNull();
    expect(classifyAddress("172.32.0.1")).toBeNull();
    expect(classifyAddress("172.16.0.1")).not.toBeNull();
    expect(classifyAddress("172.31.255.255")).not.toBeNull();
  });

  it("100.63 and 100.128 are NOT CGNAT — the /10 boundary", () => {
    expect(classifyAddress("100.63.255.255")).toBeNull();
    expect(classifyAddress("100.128.0.0")).toBeNull();
    expect(classifyAddress("100.64.0.0")).not.toBeNull();
  });
});

describe("IPv6 expansion", () => {
  it("expands the three spellings of ::ffff:127.0.0.1 to the same bytes", () => {
    const a = expandV6("::ffff:127.0.0.1");
    const b = expandV6("::ffff:7f00:1");
    const c = expandV6("0:0:0:0:0:ffff:7f00:0001");
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a?.slice(12)).toEqual([127, 0, 0, 1]);
  });

  it("expands a full address", () => {
    expect(expandV6("2606:2800:220:1:248:1893:25c8:1946")?.slice(0, 4)).toEqual([0x26, 0x06, 0x28, 0x00]);
  });

  it("rejects malformed input rather than guessing", () => {
    expect(expandV6("1:2:3")).toBeNull();
    expect(expandV6("::1::2")).toBeNull();
    expect(expandV6("zz::1")).toBeNull();
  });
});

describe("refusals name the thing that is wrong", () => {
  it("says which range, not 'invalid URL'", () => {
    const r = checkUrlText("https://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/link-local.*metadata/i);
  });

  it("explains why a port is refused", () => {
    const r = checkUrlText("https://hooks.example.com:8443/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/port scanner/);
  });
});
