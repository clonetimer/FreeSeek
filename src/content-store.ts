/**
 * Content-addressed blob store：把多模态附件从会话 JSONL 中抽离，按 SHA-256 去重保存。
 * 路径只由摘要派生，读取时再次校验摘要，避免损坏/路径注入悄悄进入模型上下文。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type ContentBlobEncoding = "data-url" | "utf8";

export interface ContentBlobRef {
  algo: "sha256";
  digest: string;
  bytes: number;
  encoding: ContentBlobEncoding;
  mimeType?: string;
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function parseDataUrl(value: string): { mimeType: string; bytes: Buffer } | null {
  const match = value.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  const mimeType = (match[1] || "application/octet-stream").trim().toLowerCase();
  try {
    const bytes = match[2]
      ? Buffer.from(match[3] || "", "base64")
      : Buffer.from(decodeURIComponent(match[3] || ""), "utf8");
    return { mimeType, bytes };
  } catch {
    return null;
  }
}

/** 共享内容仓库。不同 session 可引用同一 digest；删除单会话不会误删其它会话仍在用的内容。 */
export class ContentAddressedStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(this.root, { recursive: true });
  }

  private blobPath(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("非法 SHA-256 digest");
    return path.join(this.root, "sha256", digest.slice(0, 2), `${digest}.blob`);
  }

  /** 保存一条图片值（data URL 或普通 URL/字符串），返回稳定内容引用。 */
  putImage(value: string): ContentBlobRef {
    const parsed = parseDataUrl(value);
    const bytes = parsed?.bytes ?? Buffer.from(value, "utf8");
    const digest = sha256(bytes);
    const fp = this.blobPath(digest);
    if (!fs.existsSync(fp)) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = `${fp}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmp, bytes);
      try {
        fs.renameSync(tmp, fp);
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
        if (!fs.existsSync(fp)) throw e;
      }
    }
    return {
      algo: "sha256",
      digest,
      bytes: bytes.length,
      encoding: parsed ? "data-url" : "utf8",
      ...(parsed?.mimeType ? { mimeType: parsed.mimeType } : {}),
    };
  }

  /** 读取并验证内容；digest 不匹配时 fail-closed。 */
  readImage(ref: ContentBlobRef): string {
    if (ref.algo !== "sha256") throw new Error("不支持的内容摘要算法");
    const fp = this.blobPath(ref.digest);
    const bytes = fs.readFileSync(fp);
    if (bytes.length !== ref.bytes || sha256(bytes) !== ref.digest) {
      throw new Error(`内容 blob 校验失败：${ref.digest.slice(0, 12)}`);
    }
    if (ref.encoding === "data-url") {
      return `data:${ref.mimeType || "application/octet-stream"};base64,${bytes.toString("base64")}`;
    }
    return bytes.toString("utf8");
  }

  /** 当前 digest 是否存在且校验通过。 */
  has(ref: ContentBlobRef): boolean {
    try {
      this.readImage(ref);
      return true;
    } catch {
      return false;
    }
  }

  /** 列出当前仓库中的 digest（用于 session 删除后的引用 GC）。 */
  listDigests(): string[] {
    const base = path.join(this.root, "sha256");
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    for (const prefix of fs.readdirSync(base)) {
      const dir = path.join(base, prefix);
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        const match = name.match(/^([a-f0-9]{64})\.blob$/);
        if (match) out.push(match[1]);
      }
    }
    return out;
  }

  /** 删除一个未引用 digest；调用方必须先完成全局引用扫描。 */
  deleteDigest(digest: string): void {
    const fp = this.blobPath(digest);
    fs.rmSync(fp, { force: true });
    try { fs.rmdirSync(path.dirname(fp)); } catch { /* prefix 仍有其它 blob */ }
  }

  /** 仅用于诊断/测试：返回 blob 实际路径。 */
  pathFor(ref: ContentBlobRef): string {
    return this.blobPath(ref.digest);
  }
}
