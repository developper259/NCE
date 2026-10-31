export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const JSON_RPC_SERVER_ERROR = -32000;

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcErrorShape) {
    super(error.message || `JSON-RPC error ${error.code}`);
    this.name = "JsonRpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`The language server did not answer ${method} within ${timeoutMs} ms.`);
    this.name = "JsonRpcTimeoutError";
  }
}

export class JsonRpcCancelledError extends Error {
  constructor(method: string) {
    super(`The ${method} request was cancelled.`);
    this.name = "JsonRpcCancelledError";
  }
}

export class JsonRpcClosedError extends Error {
  constructor(reason = "The language server connection is closed.") {
    super(reason);
    this.name = "JsonRpcClosedError";
  }
}

export class JsonRpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonRpcProtocolError";
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortListener: (() => void) | null;
  signal?: AbortSignal;
}

export interface JsonRpcConnectionOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  onNotification: (method: string, params: unknown) => void;
  onRequest: (method: string, params: unknown) => Promise<unknown> | unknown;
  onProtocolError?: (error: Error) => void;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
}

type Message = JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage;

interface JsonRpcRequestMessage {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponseMessage {
  jsonrpc?: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export class JsonRpcConnection {
  private readonly options: JsonRpcConnectionOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private started = false;

  constructor(options: JsonRpcConnectionOptions) {
    this.options = options;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.input.on("data", this.onData);
    this.options.input.on("error", this.onStreamError);
    this.options.output.on("error", this.onStreamError);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new JsonRpcClosedError());
    const id = this.nextId++;
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new JsonRpcCancelledError(method));
        return;
      }
      const entry: PendingRequest = {
        method,
        resolve: resolve as (value: any) => void,
        reject,
        timer: null,
        abortListener: null,
        signal: options.signal,
      };
      entry.timer = setTimeout(() => {
        this.pending.delete(String(id));
        this.notifyUnchecked("$/cancelRequest", { id });
        reject(new JsonRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      if (options.signal) {
        const abortListener = () => {
          if (!this.pending.delete(String(id))) return;
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = null;
          this.notifyUnchecked("$/cancelRequest", { id });
          reject(new JsonRpcCancelledError(method));
        };
        entry.abortListener = abortListener;
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(String(id), entry);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  dispose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.options.input.off("data", this.onData);
    this.options.input.off("error", this.onStreamError);
    this.options.output.off("error", this.onStreamError);
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.abortListener && entry.signal)
        entry.signal.removeEventListener("abort", entry.abortListener);
      entry.reject(error || new JsonRpcClosedError());
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }

  private notifyUnchecked(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"),
      payload,
    ]);
    try {
      this.options.output.write(frame, (error?: Error | null) => {
        if (error) this.fail(new JsonRpcProtocolError(`Unable to write to the language server: ${error.message}`));
      });
    } catch (error) {
      this.fail(new JsonRpcProtocolError(`Unable to write to the language server: ${String(error)}`));
    }
  }

  private readonly onStreamError = (error: Error): void => {
    this.fail(new JsonRpcProtocolError(`Language server stream error: ${error.message}`));
  };

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, buffer]) : buffer;
    try {
      this.drainMessages();
    } catch (error) {
      this.fail(error instanceof Error ? error : new JsonRpcProtocolError(String(error)));
    }
  };

  private drainMessages(): void {
    const maxBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    while (true) {
      const separatorIndex = this.buffer.indexOf(HEADER_SEPARATOR);
      if (separatorIndex < 0) {
        if (this.buffer.length > 64 * 1024)
          throw new JsonRpcProtocolError("Language server sent oversized headers.");
        return;
      }
      const header = this.buffer.subarray(0, separatorIndex).toString("ascii");
      let contentLength: number | null = null;
      for (const line of header.split("\r\n")) {
        const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line);
        if (match) contentLength = Number(match[1]);
      }
      if (contentLength === null || !Number.isSafeInteger(contentLength) || contentLength < 0)
        throw new JsonRpcProtocolError("Language server message is missing a valid Content-Length header.");
      if (contentLength > maxBytes)
        throw new JsonRpcProtocolError(`Language server message exceeds ${maxBytes} bytes.`);
      const bodyStart = separatorIndex + HEADER_SEPARATOR.length;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleBody(body);
    }
  }

  private handleBody(body: string): void {
    let message: Message | Message[];
    try {
      message = JSON.parse(body);
    } catch (error) {
      throw new JsonRpcProtocolError(`Language server sent malformed JSON: ${String(error)}`);
    }
    if (Array.isArray(message)) {
      for (const entry of message) this.handleMessage(entry);
      return;
    }
    this.handleMessage(message);
  }

  private handleMessage(message: Message): void {
    if (!message || typeof message !== "object") return;
    if ("method" in message && typeof message.method === "string") {
      if ("id" in message && message.id !== undefined) {
        const request = message as JsonRpcRequestMessage;
        void this.handleServerRequest(request);
      } else {
        const notification = message as JsonRpcNotificationMessage;
        try {
          this.options.onNotification(notification.method, notification.params);
        } catch (error) {
          this.options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return;
    }
    this.handleResponse(message as JsonRpcResponseMessage);
  }

  private async handleServerRequest(request: JsonRpcRequestMessage): Promise<void> {
    try {
      const result = await this.options.onRequest(request.method, request.params);
      this.send({ jsonrpc: "2.0", id: request.id, result: result ?? null });
    } catch (error) {
      const shape = error as { code?: unknown; message?: unknown };
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: typeof shape?.code === "number" ? shape.code : JSON_RPC_INTERNAL_ERROR,
          message: typeof shape?.message === "string" ? shape.message : String(error),
        },
      });
    }
  }

  private handleResponse(message: JsonRpcResponseMessage): void {
    if (message.id === null || message.id === undefined) return;
    const entry = this.pending.get(String(message.id));
    if (!entry) return;
    this.pending.delete(String(message.id));
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.abortListener && entry.signal)
      entry.signal.removeEventListener("abort", entry.abortListener);
    if (message.error) {
      entry.reject(new JsonRpcResponseError(message.error));
      return;
    }
    entry.resolve(message.result);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.options.onProtocolError?.(error);
    this.dispose(error);
  }
}
