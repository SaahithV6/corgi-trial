/**
 * JSON-RPC 2.0, hand-rolled.
 *
 * WHY NOT THE OFFICIAL SDK. `@modelcontextprotocol/sdk` resolves cleanly on
 * the registry (checked: 1.30.0). It is not used here for one hard reason and
 * one soft one.
 *
 *   Hard: adding it means editing `package.json` and the lockfile, which this
 *   worker does not own. A dependency added behind another worker's back is
 *   how you get a red CI run at hour 44.
 *
 *   Soft: the SDK's HTTP transport (`StreamableHTTPServerTransport`) is built
 *   against Node's `IncomingMessage`/`ServerResponse`. Next's App Router hands
 *   a route handler a WHATWG `Request` and wants a `Response` back, so using
 *   it means shimming a fake Node req/res pair around a Web stream — more
 *   novel code than the protocol itself. The wire surface an MCP client
 *   actually exercises is `initialize`, `tools/list` and `tools/call` over
 *   JSON-RPC 2.0, which is this file plus `protocol.ts`: about 300 lines,
 *   fully tested, with no runtime dependency.
 *
 * Everything here is transport-agnostic and synchronous. It knows nothing
 * about MCP, money, or HTTP.
 */

export const JSONRPC_VERSION = "2.0";

/** An id on the wire. `null` is legal on a response to an unparseable request. */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  /** Absent on a notification. Notifications get no response, ever. */
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number;
  readonly result: unknown;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

// ---- Error codes ------------------------------------------------------
// -32768..-32000 is reserved by the spec. The five below are the spec's own;
// the rest sit in the reserved implementation-defined band and are documented
// in docs/MCP.md so a client can branch on them.

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** No credential, or one that does not resolve. Paired with HTTP 401. */
export const UNAUTHORIZED = -32001;
/** A credential that resolves but may not do this. Paired with HTTP 403. */
export const FORBIDDEN = -32003;
/** Too many calls on this token. Paired with HTTP 429 and Retry-After. */
export const RATE_LIMITED = -32029;
/** The request is well-formed but the server refuses it before dispatch. */
export const REQUEST_REFUSED = -32002;

export class JsonRpcError extends Error {
  override readonly name = "JsonRpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }

  toBody(): JsonRpcErrorBody {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function success(id: string | number, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined;
}

/**
 * The outcome of decoding one HTTP body.
 *
 * `batch` is deliberately absent. JSON-RPC allows an array of requests; MCP
 * removed batching in revision 2025-06-18, and supporting it would mean this
 * server has to decide what a partially-rate-limited batch means for the audit
 * log. One request, one audit record, one outcome.
 */
export type DecodedMessage =
  | { readonly kind: "request"; readonly request: JsonRpcRequest }
  | { readonly kind: "error"; readonly failure: JsonRpcFailure };

/** Decode a body that has already been read as text. Never throws. */
export function decodeMessage(text: string): DecodedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      kind: "error",
      failure: failure(null, PARSE_ERROR, "request body is not valid JSON", {
        detail: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  if (Array.isArray(parsed)) {
    return {
      kind: "error",
      failure: failure(
        null,
        INVALID_REQUEST,
        "JSON-RPC batching is not supported; MCP removed it in revision 2025-06-18. Send one request per HTTP POST.",
      ),
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return {
      kind: "error",
      failure: failure(null, INVALID_REQUEST, "request body must be a JSON object"),
    };
  }

  const raw = parsed as Record<string, unknown>;

  // The id is recovered BEFORE validation so that a malformed request still
  // gets an answer the client can correlate. A client that never learns which
  // of its in-flight calls failed will retry the wrong one.
  const rawId = raw["id"];
  const id: string | number | undefined =
    typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId))
      ? rawId
      : undefined;

  if (raw["jsonrpc"] !== JSONRPC_VERSION) {
    return {
      kind: "error",
      failure: failure(
        id ?? null,
        INVALID_REQUEST,
        `jsonrpc must be the string "2.0", received ${JSON.stringify(raw["jsonrpc"])}`,
      ),
    };
  }

  if (typeof raw["method"] !== "string" || raw["method"] === "") {
    return {
      kind: "error",
      failure: failure(id ?? null, INVALID_REQUEST, "method must be a non-empty string"),
    };
  }

  if (rawId !== undefined && id === undefined) {
    return {
      kind: "error",
      failure: failure(
        null,
        INVALID_REQUEST,
        "id, when present, must be a string or a finite number",
      ),
    };
  }

  const rawParams = raw["params"];
  if (
    rawParams !== undefined &&
    (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams))
  ) {
    // The spec permits positional params. MCP does not use them, and accepting
    // them would mean every tool has to define an argument ORDER as well as a
    // schema — a second contract to keep in sync, for no caller.
    return {
      kind: "error",
      failure: failure(
        id ?? null,
        INVALID_PARAMS,
        "params must be an object; positional parameters are not supported",
      ),
    };
  }

  const request: JsonRpcRequest = {
    jsonrpc: JSONRPC_VERSION,
    method: raw["method"],
    ...(id === undefined ? {} : { id }),
    ...(rawParams === undefined ? {} : { params: rawParams as Record<string, unknown> }),
  };
  return { kind: "request", request };
}
