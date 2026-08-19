/**
 * 编码探测与编解码（文件工具缺口补齐：编码探测 + 冲突检测）。
 *
 * 设计要点：
 *  - BOM 优先：UTF-8 / UTF-16LE / UTF-16BE / UTF-32 的 BOM 直接判定。
 *  - 无 BOM 时先用严格 UTF-8 试探（失败即非 UTF-8）。
 *  - 否则按中文常见编码回退：gb18030（覆盖 GBK/GB2312）→ big5 → shift_jis → euc-kr。
 *  - 读侧用 Node 自带 TextDecoder（Electron/Node 官方构建含 full-icu，支持上述标签）；
 *    写侧用 iconv-lite 做 UTF-8 ↔ 其它编码的双向转换（TextEncoder 仅支持 UTF-8，无法直接编码 GBK）。
 *  - 同时给出无 BOM 时的"被测编码"提示，便于工具层提示模型"该文件非 UTF-8，写回会保留原编码"。
 */
import * as iconvLite from "iconv-lite";

export interface EncodingInfo {
  /** 探测到的编码标签（utf-8 / utf-16le / gb18030 / big5 / shift_jis / euc-kr 等）。 */
  encoding: string;
  /** 是否带 BOM。 */
  bom: boolean;
  /** 解码为 JS 字符串。 */
  text: string;
}

/** 各编码被探测为"无 BOM 回退"时的展示优先级。 */
const FALLBACK_ENCODINGS = ["gb18030", "big5", "shift_jis", "euc-kr"];

/** 按 BOM 判定编码（返回编码标签与 BOM 字节长度）。 */
function detectBom(buf: Buffer): { encoding: string; bomLen: number } | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf-8", bomLen: 3 };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: "utf-16le", bomLen: 2 };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: "utf-16be", bomLen: 2 };
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0xff &&
    buf[1] === 0xfe &&
    buf[2] === 0x00 &&
    buf[3] === 0x00
  ) {
    return { encoding: "utf-32le", bomLen: 4 };
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x00 &&
    buf[1] === 0x00 &&
    buf[2] === 0xfe &&
    buf[3] === 0xff
  ) {
    return { encoding: "utf-32be", bomLen: 4 };
  }
  return null;
}

/** 探测 Buffer 的编码并解码为字符串。 */
export function decodeBuffer(buf: Buffer): EncodingInfo {
  const bom = detectBom(buf);
  if (bom) {
    const rest = buf.subarray(bom.bomLen);
    const label = bom.encoding === "utf-16be" ? "utf-16be" : bom.encoding === "utf-32be" ? "utf-32be" : bom.encoding;
    const text = new TextDecoder(label).decode(rest);
    return { encoding: bom.encoding, bom: true, text };
  }
  // 无 BOM：严格 UTF-8 试探
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { encoding: "utf-8", bom: false, text };
  } catch {
    /* 非 UTF-8，进入回退链 */
  }
  for (const enc of FALLBACK_ENCODINGS) {
    try {
      const text = iconvLite.decode(buf, enc);
      // 若解码结果含大量替换字符（U+FFFD），说明编码不匹配，继续尝试下一个
      const replacementHits = (text.match(/�/g) || []).length;
      if (replacementHits > buf.length / 16) continue;
      return { encoding: enc, bom: false, text };
    } catch {
      /* 该编码不支持，跳下一个 */
    }
  }
  // 全部失败：退回 GB18030 尽力解码（几乎总能解码任意字节）
  const text = iconvLite.decode(buf, "gb18030");
  return { encoding: "gb18030", bom: false, text };
}

/** 将 JS 字符串按指定编码编码为 Buffer（保留 BOM 标记由调用方决定是否加）。 */
export function encodeBuffer(text: string, encoding: string, withBom: boolean): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === "utf-8" || enc === "utf8" || enc === "ascii") {
    const body = Buffer.from(text, "utf8");
    if (withBom) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
    return body;
  }
  // 其余编码走 iconv-lite（支持 BOM 的编码由 iconv-lite 通过 "utf16-le" + addBOM 控制）
  if (enc === "utf-16le") {
    return iconvLite.encode(text, "utf16-le", { addBOM: withBom });
  }
  if (enc === "utf-16be") {
    return iconvLite.encode(text, "utf16-be", { addBOM: withBom });
  }
  if (enc === "utf-32le" || enc === "utf-32be") {
    // iconv-lite 不支持 utf-32，退回用 TextEncoder 的 utf-16 路径无法覆盖；
    // 退化为不写 BOM 的 32-bit 编码（极端场景，罕见）。
    const le = enc === "utf-32le";
    const out: number[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      const bytes = le ? [cp & 0xff, (cp >> 8) & 0xff, (cp >> 16) & 0xff, (cp >> 24) & 0xff] : [(cp >> 24) & 0xff, (cp >> 16) & 0xff, (cp >> 8) & 0xff, cp & 0xff];
      out.push(...bytes);
    }
    return Buffer.from(out);
  }
  // gb18030 / big5 / shift_jis / euc-kr 等双字节编码（无 Unicode BOM 概念）
  return iconvLite.encode(text, enc);
}

/** 是否为"非 UTF-8"编码（写回时需特殊提示）。 */
export function isNonUtf8(enc: string): boolean {
  return !/^utf-?8$/i.test(enc);
}
