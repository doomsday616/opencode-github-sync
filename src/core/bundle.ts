import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Support bundle: diagnostics, logs and settings with secrets removed, packed
 * as a .tar.gz using only the standard library.
 */

const SECRET_KEY =
  /(token|secret|password|passwd|apikey|api_key|api-key|auth|credential|cookie|key)$/i;

/** Remove anything that looks like a credential from free text. */
export function redactText(text: string): string {
  return (
    String(text)
      // user:pass@ and token@ in URLs
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
      // GitHub, npm, OpenAI-style and generic bearer tokens
      .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
      .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
      .replace(/((?:bearer|basic)\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
      .replace(/(authorization:\s*token\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
      // key = value / "key": "value" pairs whose key names a secret
      .replace(
        /("?[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_-]*"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
        '$1"[REDACTED]"',
      )
  );
}

/** Deep-copy a JSON value with secret-looking keys blanked and strings scrubbed. */
export function redactValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return key && SECRET_KEY.test(key) && value ? "[REDACTED]" : redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}

// ── Minimal ustar writer ────────────────────────────────────────────────────

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mtime: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length > 100) throw new Error(`tar entry name too long: ${name}`);
  nameBytes.copy(buf, 0);
  buf.write(octal(0o644, 8), 100, "ascii");
  buf.write(octal(0, 8), 108, "ascii");
  buf.write(octal(0, 8), 116, "ascii");
  buf.write(octal(size, 12), 124, "ascii");
  buf.write(octal(Math.floor(mtime / 1000), 12), 136, "ascii");
  buf.write("        ", 148, "ascii");
  buf.write("0", 156, "ascii");
  buf.write("ustar\0", 257, "ascii");
  buf.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return buf;
}

export interface BundleEntry {
  name: string;
  content: string | Buffer;
}

export function tarGz(entries: BundleEntry[], mtime = Date.now()): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, "utf8");
    parts.push(header(entry.name, data.length, mtime), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

export function writeBundle(dir: string, entries: BundleEntry[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `opencode-sync-support-${stamp}.tar.gz`);
  const redacted = entries.map((e) => ({
    name: e.name,
    content: Buffer.isBuffer(e.content) ? e.content : redactText(e.content),
  }));
  fs.writeFileSync(file, tarGz(redacted, now.getTime()));
  return file;
}
