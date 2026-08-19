/**
 * 极简 CDP（Chrome DevTools Protocol）客户端：RFC 6455 WebSocket + JSON-RPC，零依赖。
 * 用于控制真实 Chrome（--remote-debugging-port）或 headless 实例。
 *
 * 仅支持本地 ws://（Chrome CDP 场景），不支持 wss://TLS。
 */
import * as http from "node:http";
import type { Socket } from "node:net";
import * as crypto from "node:crypto";

export interface CdpEvent {
  method: string;
  params: any;
}

export class CdpSession {
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, (msg: any) => void>();
  private listeners = new Map<string, ((params: any) => void)[]>();
  private onceListeners = new Map<string, ((params: any) => void)[]>();
  private nextId = 1;
  private closed = false;

  /** 连接到一个 CDP WebSocket 端点（webSocketDebuggerUrl）。 */
  static connect(wsUrl: string): Promise<CdpSession> {
    const u = new URL(wsUrl);
    if (u.protocol !== "ws:") throw new Error(`仅支持 ws:// 端点，收到: ${u.protocol}`);
    const key = crypto.randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 80,
        path: u.pathname + u.search,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("upgrade", (_res, socket) => {
        const s = new CdpSession();
        s.sock = socket;
        s.attach();
        socket.on("close", () => s.handleClose());
        socket.on("error", () => s.handleClose());
        resolve(s);
      });
      req.on("error", reject);
      req.setTimeout(8000, () => req.destroy(new Error("CDP 连接超时")));
      req.end();
    });
  }

  /** 发送 CDP 命令，返回 result（不含 id）。 */
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("CDP 连接已关闭"));
      const id = this.nextId++;
      this.pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`${method}: ${msg.error?.message ?? JSON.stringify(msg.error)}`));
        else resolve(msg.result ?? {});
      });
      this.sendFrame(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时: ${method}`));
        }
      }, 20_000);
    });
  }

  /** 订阅事件。 */
  on(method: string, cb: (params: any) => void): void {
    const arr = this.listeners.get(method) ?? [];
    arr.push(cb);
    this.listeners.set(method, arr);
  }

  /** 等待单个事件（一次性），超时返回 null。 */
  waitEvent(method: string, timeoutMs = 6000): Promise<any | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const arr = this.onceListeners.get(method);
        if (arr) {
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        }
        resolve(null);
      }, timeoutMs);
      const cb = (params: any) => {
        clearTimeout(timer);
        const arr = this.onceListeners.get(method);
        if (arr) {
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        }
        resolve(params);
      };
      const arr = this.onceListeners.get(method) ?? [];
      arr.push(cb);
      this.onceListeners.set(method, arr);
    });
  }

  close(): void {
    try {
      this.sendFrame(JSON.stringify({ id: this.nextId++, method: "Browser.close" }), 0x8);
    } catch {
      /* ignore */
    }
    this.sock?.end();
    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("CDP 连接已断开");
    for (const p of this.pending.values()) p({ error: { message: err.message } });
    this.pending.clear();
    this.sock = null;
  }

  private attach(): void {
    this.sock?.on("data", (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      for (;;) {
        const len = this.frameLength();
        if (len < 0 || this.buf.length < len) break;
        const frame = this.buf.subarray(0, len);
        this.buf = this.buf.subarray(len);
        this.handleFrame(frame);
      }
    });
  }

  /** 返回当前缓冲中首帧总长度；数据不足返回 -1。 */
  private frameLength(): number {
    if (this.buf.length < 2) return -1;
    const b1 = this.buf[1];
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (this.buf.length < 4) return -1;
      len = this.buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (this.buf.length < 10) return -1;
      len = Number(this.buf.readBigUInt64BE(2));
      off = 10;
    }
    if ((b1 & 0x80) !== 0) off += 4; // 服务端→客户端不应掩码，防御性跳过
    return off + len;
  }

  private handleFrame(frame: Buffer): void {
    const b0 = frame[0];
    const b1 = frame[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let off = 2;
    let len = b1 & 0x7f;
    if (len === 126) {
      len = frame.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      len = Number(frame.readBigUInt64BE(2));
      off = 10;
    }
    let payload: Buffer;
    if (masked) {
      const mask = frame.subarray(off, off + 4);
      off += 4;
      payload = Buffer.from(frame.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    } else {
      payload = frame.subarray(off, off + len);
    }

    if (opcode === 1 || opcode === 0) {
      // text / continuation（CDP 消息为独立短帧，不做跨帧拼接）
      let msg: any;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p(msg);
        }
      } else if (msg.method) {
        const params = msg.params ?? {};
        for (const cb of this.listeners.get(msg.method) ?? []) cb(params);
        for (const cb of this.onceListeners.get(msg.method) ?? []) cb(params);
        this.onceListeners.delete(msg.method);
      }
    } else if (opcode === 9) {
      // ping → pong
      this.sendRaw(payload, 0xa);
    } else if (opcode === 8) {
      this.handleClose();
      this.sock?.end();
    }
  }

  private sendFrame(text: string, opcode = 0x1): void {
    if (!this.sock) return;
    this.sendRaw(Buffer.from(text, "utf8"), opcode);
  }

  private sendRaw(payload: Buffer, opcode: number): void {
    if (!this.sock) return;
    const len = payload.length;
    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header.writeUInt32BE(mask.readUInt32BE(0), header.length - 4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < len; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([header, masked]));
  }
}
