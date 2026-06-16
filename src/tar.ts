import { gzipSync, gunzipSync } from "zlib";

export interface TarEntry {
  /** Forward-slash relative path, e.g. "memory/2026-06-01.md" */
  path: string;
  content: Buffer;
}

const BLOCK = 512;

function pad(value: string, length: number): Buffer {
  const buf = Buffer.alloc(length);
  buf.write(value, "utf-8");
  return buf;
}

function octal(value: number, length: number): Buffer {
  return pad(value.toString(8).padStart(length - 1, "0"), length);
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum;
}

function writeHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  pad(path, 100).copy(header, 0);
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108); // uid
  octal(0, 8).copy(header, 116); // gid
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136); // mtime
  pad("        ", 8).copy(header, 148); // checksum placeholder
  header[156] = "0".charCodeAt(0); // type: regular file
  pad("ustar", 6).copy(header, 257);
  pad("00", 2).copy(header, 263);

  octal(checksum(header), 8).copy(header, 148);
  return header;
}

/** Builds a minimal ustar tarball, gzip-compressed. */
export function createTarGz(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    chunks.push(writeHeader(entry.path, entry.content.length));
    chunks.push(entry.content);
    const remainder = entry.content.length % BLOCK;
    if (remainder !== 0) chunks.push(Buffer.alloc(BLOCK - remainder));
  }

  // Two zeroed blocks mark the end of the archive.
  chunks.push(Buffer.alloc(BLOCK * 2));

  return gzipSync(Buffer.concat(chunks));
}

/** Reads back a tarball produced by `createTarGz`. */
export function extractTarGz(buf: Buffer): TarEntry[] {
  const tar = gunzipSync(buf);
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;

    const path = header.toString("utf-8", 0, 100).replace(/\0.*$/, "");
    const size = Number.parseInt(header.toString("utf-8", 124, 136).replace(/\0.*$/, "").trim(), 8) || 0;

    offset += BLOCK;
    const content = Buffer.from(tar.subarray(offset, offset + size));
    entries.push({ path, content });

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}
