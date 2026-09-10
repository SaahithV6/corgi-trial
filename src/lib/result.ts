/**
 * A tiny typed Result.
 *
 * Used at the API boundary so a route handler's failure modes are part of its
 * type rather than a thrown value that some caller may or may not catch. This
 * is intentionally minimal: no chaining DSL, no do-notation. Money code should
 * read like a list of steps.
 *
 *   const r = await charge(...);
 *   if (isErr(r)) return jsonResult(r, { errorStatus: 402 });
 *   use(r.value);
 */

export type Ok<T> = { readonly ok: true; readonly value: T };

export type Err<E> = { readonly ok: false; readonly error: E };

export type Result<T, E = ErrorShape> = Ok<T> | Err<E>;

/** The error body shape returned to clients. Stable across every route. */
export type ErrorShape = {
  /** Machine-readable, screaming snake case, e.g. `INSUFFICIENT_FUNDS`. */
  readonly code: string;
  /** Human-readable, safe to show. Never contains secrets or raw provider text. */
  readonly message: string;
  /** Optional structured detail, e.g. field-level validation problems. */
  readonly details?: unknown;
};

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Build a standard `ErrorShape` failure. */
export function fail(
  code: string,
  message: string,
  details?: unknown,
): Err<ErrorShape> {
  return err(details === undefined ? { code, message } : { code, message, details });
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Unwrap, or throw. Only for code paths where an `Err` is genuinely a bug. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(`unwrap() on Err: ${JSON.stringify(result.error)}`);
}

/** Unwrap, or fall back. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Run a throwing function and capture the throw as an `Err`. */
export function attempt<T>(fn: () => T): Result<T, unknown> {
  try {
    return ok(fn());
  } catch (thrown) {
    return err(thrown);
  }
}

/** Await a promise and capture a rejection as an `Err`. */
export async function attemptAsync<T>(
  promise: Promise<T> | (() => Promise<T>),
): Promise<Result<T, unknown>> {
  try {
    return ok(await (typeof promise === "function" ? promise() : promise));
  } catch (thrown) {
    return err(thrown);
  }
}

/**
 * Serialise a Result as an HTTP response body.
 *
 * `Ok` becomes the value at the top level; `Err` becomes `{ error: ... }`, so
 * a client can branch on the presence of `error` without inspecting status.
 */
export function toResponseBody<T>(
  result: Result<T, ErrorShape>,
): T | { error: ErrorShape } {
  return result.ok ? result.value : { error: result.error };
}
