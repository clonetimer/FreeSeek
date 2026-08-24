import type { Readable, Writable } from "stream";

export type JsonRpcId = string | number | null;

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class AcpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "AcpRpcError";
  }

  static invalidRequest(message = "Invalid Request", data?: unknown): AcpRpcError {
    return new AcpRpcError(-32600, message, data);
  }

  static methodNotFound(method: string): AcpRpcError {
    return new AcpRpcError(-32601, `Method not found: ${method}`);
  }

  static invalidParams(message: string, data?: unknown): AcpRpcError {
    return new AcpRpcError(-32602, message, data);
  }

  static internal(message: string, data?: unknown): AcpRpcError {
    return new AcpRpcError(-32603, message, data);
  }
}

export type AcpRpcHandler = (method: string, params: unknown, requestId?: JsonRpcId) => Promise<unknown> | unknown;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/**
 * ACP stdio uses newline-delimited JSON-RPC 2.0. This peer is deliberately
 * transport-only: protocol methods live in the ACP host, while this layer owns
 * framing, bidirectional request correlation and JSON-RPC error envelopes.
 */
export class NdJsonRpcPeer {
  private buffer = "";
  private requestSeq = 0;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private handler: AcpRpcHandler | null = null;
  private started = false;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onProtocolError: (message: string) => void = () => undefined
  ) {
    this.closedPromise = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  }

  start(handler: AcpRpcHandler): void {
    if (this.started) throw new Error("ACP RPC peer already started");
    this.started = true;
    this.handler = handler;
    this.input.setEncoding("utf8");
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.on("error", this.onInputError);
  }

  close(reason = "ACP transport closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onInputError);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.resolveClosed();
  }

  /** Resolve when stdin closes or the host explicitly closes the transport. */
  waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP transport is closed"));
    const id = `freesek:${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("ACP request cancelled"));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.pending.set(id, { resolve, reject, cleanup });
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  private readonly onData = (chunk: string | Buffer): void => {
    this.buffer += String(chunk);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) void this.handleLine(line);
    }
  };

  private readonly onEnd = (): void => {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) {
      void this.handleLine(tail).finally(() => this.close("ACP input ended"));
      return;
    }
    this.close("ACP input ended");
  };

  private readonly onInputError = (error: Error): void => {
    this.onProtocolError(`ACP input error: ${error.message}`);
    this.close(error.message);
  };

  private async handleLine(line: string): Promise<void> {
    let value: any;
    try {
      value = JSON.parse(line);
    } catch (error: any) {
      this.onProtocolError(`ACP parse error: ${error?.message ?? String(error)}`);
      this.writeError(null, new AcpRpcError(-32700, "Parse error"));
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0") {
      this.writeError(null, AcpRpcError.invalidRequest());
      return;
    }

    if (typeof value.method === "string") {
      const hasId = Object.prototype.hasOwnProperty.call(value, "id");
      const id = hasId ? value.id : undefined;
      if (hasId && !isJsonRpcId(id)) {
        this.writeError(null, AcpRpcError.invalidRequest("JSON-RPC id must be a string, finite number, or null"));
        return;
      }
      if (!this.handler) {
        if (hasId) this.writeError(id as JsonRpcId, AcpRpcError.internal("ACP handler unavailable"));
        return;
      }
      try {
        const result = await this.handler(value.method, value.params, hasId ? id as JsonRpcId : undefined);
        if (hasId) this.write({ jsonrpc: "2.0", id: id as JsonRpcId, result: result ?? {} });
      } catch (error: any) {
        if (hasId) this.writeError(id as JsonRpcId, this.normalizeError(error));
        else this.onProtocolError(`ACP notification ${value.method} failed: ${error?.message ?? String(error)}`);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(value, "id")) {
      if (!isJsonRpcId(value.id)) {
        this.onProtocolError("ACP response contained an invalid JSON-RPC id");
        return;
      }
      const id = value.id;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.cleanup();
      if (value.error) {
        pending.reject(new AcpRpcError(Number(value.error.code) || -32603, String(value.error.message || "RPC error"), value.error.data));
      } else {
        pending.resolve(value.result);
      }
      return;
    }

    this.writeError(null, AcpRpcError.invalidRequest());
  }

  private normalizeError(error: unknown): AcpRpcError {
    if (error instanceof AcpRpcError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return AcpRpcError.internal(message);
  }

  private writeError(id: JsonRpcId, error: AcpRpcError): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    });
  }

  private write(value: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (this.closed) return;
    this.output.write(JSON.stringify(value) + "\n");
  }
}
