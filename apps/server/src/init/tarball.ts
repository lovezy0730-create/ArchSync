/**
 * Minimal tar reader (USTAR/GNU, regular files only) + gzip via node:zlib.
 * Used by the init wizard to read a GitHub tarball in a single anonymous
 * request (codeload is not API-rate-limited), avoiding per-file API calls.
 */
import { gunzipSync } from 'node:zlib';

export interface TarEntry {
  path: string;
  content: string;
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(8000, buffer.length));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

/** Parse a .tar buffer; only regular text files are returned. */
export function parseTar(buffer: Buffer, maxEntries = 20000): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length && entries.length < maxEntries) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive
    const name = readString(header, 0, 100);
    const size = parseInt(readString(header, 124, 12).trim() || '0', 8);
    const typeflag = String.fromCharCode(header[156] ?? 48);
    const prefix = readString(header, 345, 155);
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    offset += 512;
    if (typeflag === '0' || typeflag === '\0') {
      const content = buffer.subarray(offset, offset + size);
      if (size > 0 && size <= 512 * 1024 && !isProbablyBinary(content)) {
        entries.push({ path: fullName, content: content.toString('utf8') });
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** Download and extract a repo tarball (single anonymous codeload request). */
export async function fetchTarballEntries(owner: string, repo: string, ref = 'HEAD'): Promise<TarEntry[]> {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ArchSync-Init-Wizard' } });
  if (!res.ok) {
    throw new Error(`下载 ${owner}/${repo} tarball 失败: HTTP ${res.status}（仓库可能不存在或为私有）`);
  }
  const gz = Buffer.from(await res.arrayBuffer());
  const tar = gunzipSync(gz);
  // strip the leading "<repo>-<ref>/" component GitHub adds
  const entries = parseTar(tar);
  const prefix = entries[0]?.path.split('/')[0];
  return entries.map((e) => ({
    path: prefix && e.path.startsWith(`${prefix}/`) ? e.path.slice(prefix.length + 1) : e.path,
    content: e.content,
  }));
}
