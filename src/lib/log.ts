/**
 * Structured logging.
 *
 * One JSON object per line on stdout/stderr. No pretty-printing, no colours,
 * no multi-line messages: every line has to survive being grepped out of a
 * platform log drain months later, and a stack trace split across lines does
 * not.
 *
 * Every line carries a request id. Anything money-shaped should also carry the
 * ids that let a reader walk to the ledger: `accountId`, `transactionId`,
 * `entryId`, `idempotencyKey`.
 *
 *   const log = logger({ requestId });
 *   log.info("auth.received", { cardId, amountCents });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const raw = process.env["LOG_LEVEL"]?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return process.env["NODE_ENV"] === "production" ? "info" : "debug";
}

/**
 * Keys whose values are redacted wherever they appear in log fields. Logging a
 * secret is a one-line mistake that outlives the deploy that made it, so the
 * logger refuses rather than trusting every call site.
 */
const REDACT = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "privatekey",
  "private_key",
  "pan",
  "cvv",
  "cvc",
  "ssn",
  "taxid",
  "tax_id",
];

function shouldRedact(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT.some((needle) => k.includes(needle));
}

/** JSON-safe: handles Error, BigInt, Map/Set, cycles, and redacts secrets. */
function sanitise(value: unknown, seen: WeakSet<object>, key?: string): unknown {
  if (key !== undefined && shouldRedact(key)) return "[redacted]";

  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object") return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
      ...(value.cause === undefined
        ? {}
        : { cause: sanitise(value.cause, seen) }),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return sanitise(Object.fromEntries(value), seen);
  if (value instanceof Set) return sanitise([...value], seen);

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => sanitise(item, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitise(v, seen, k);
  return out;
}

export type Logger = {
  /** The request id every line from this logger carries. */
  readonly requestId: string;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Derive a logger with extra fields bound to every line. */
  child(fields: LogFields): Logger;
};

/** A URL-safe, sortable-enough request id. */
export function newRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Pull a request id off an inbound request, falling back to a fresh one.
 * Honours the common proxy headers so a trace survives the edge.
 */
export function requestIdFrom(headers: Headers): string {
  return (
    headers.get("x-request-id") ??
    headers.get("x-correlation-id") ??
    headers.get("x-vercel-id") ??
    newRequestId()
  );
}

type Emit = (line: string, level: LogLevel) => void;

const defaultEmit: Emit = (line, level) => {
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export type LoggerOptions = {
  requestId?: string;
  /** Bound fields repeated on every line. */
  base?: LogFields;
  /** Override the sink. Tests pass a collector here. */
  emit?: Emit;
  /** Override the minimum level. Defaults to LOG_LEVEL / NODE_ENV. */
  level?: LogLevel;
};

export function logger(options: LoggerOptions = {}): Logger {
  const requestId = options.requestId ?? newRequestId();
  const base = options.base ?? {};
  const emit = options.emit ?? defaultEmit;
  const min = LEVEL_ORDER[options.level ?? configuredLevel()];

  function write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < min) return;

    const merged = sanitise({ ...base, ...fields }, new WeakSet()) as LogFields;
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      requestId,
      ...merged,
    };

    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({
        ts: record.ts,
        level,
        event,
        requestId,
        error: "log serialisation failed",
      });
    }
    emit(line, level);
  }

  return {
    requestId,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) =>
      logger({
        ...options,
        requestId,
        base: { ...base, ...fields },
      }),
  };
}

/**
 * Process-level logger for code with no request in scope (boot, migrations,
 * cron). Its request id is stable for the life of the process.
 */
export const rootLogger: Logger = logger({ requestId: newRequestId() });
