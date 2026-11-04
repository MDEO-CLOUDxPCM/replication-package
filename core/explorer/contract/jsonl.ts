/**
 * designs.jsonl (contract 0.2.0): line 1 a DesignStreamHeader, then one Design per line.
 * Node only. The reader streams the file in chunks (never one huge string) and reports each line's
 * byte offset and length, so a reader can keep summaries only and read a single design on demand.
 */
import fs from 'node:fs';
import type { Design, DesignStreamHeader, DesignSummary } from './types';

const NL = 0x0a;

/**
 * Calls `onLine(value, offset, length, index)` for every non-empty line (index 0 = the header).
 * `offset`/`length` are byte positions of the line without its newline. Return `false` to stop.
 */
export async function scanJsonl(file: string, onLine: (value: unknown, offset: number, length: number, index: number) => void | false, chunkSize = 4 << 20): Promise<void> {
  const fh = await fs.promises.open(file, 'r');
  try {
    let carry: Buffer = Buffer.alloc(0);
    let carryAt = 0; // file offset of carry[0]
    let pos = 0;
    let index = 0;
    const chunk = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunkSize, pos);
      const eof = bytesRead === 0;
      const buf = eof ? carry : carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const bufAt = carryAt;
      pos += bytesRead;
      let start = 0;
      for (;;) {
        let nl = buf.indexOf(NL, start);
        if (nl < 0) { if (!eof) break; nl = buf.length; }
        let end = nl;
        if (end > start && buf[end - 1] === 0x0d) end--; // CRLF
        if (end > start) {
          const value = JSON.parse(buf.toString('utf8', start, end));
          if (onLine(value, bufAt + start, end - start, index++) === false) return;
        }
        start = nl + 1;
        if (start >= buf.length) break;
      }
      if (eof) return;
      // copy: `chunk` is reused for the next read
      carry = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
      carryAt = bufAt + Math.min(start, buf.length);
    }
  } finally {
    await fh.close();
  }
}

/** one line of a jsonl file by its byte range */
export async function readJsonlAt<T>(file: string, offset: number, length: number): Promise<T> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return JSON.parse(buf.toString('utf8', 0, bytesRead)) as T;
  } finally {
    await fh.close();
  }
}

export interface DesignIndexEntry { offset: number; length: number }

/** the summaries of a designs.jsonl file plus the byte range of every design */
export async function indexDesignsJsonl(file: string): Promise<{ header: DesignStreamHeader; summaries: DesignSummary[]; at: Map<string, DesignIndexEntry> }> {
  let header: DesignStreamHeader | undefined;
  const summaries: DesignSummary[] = [];
  const at = new Map<string, DesignIndexEntry>();
  await scanJsonl(file, (v, offset, length, i) => {
    if (i === 0) {
      header = v as DesignStreamHeader;
      if (!header || typeof header !== 'object' || 'objectives' in header) throw new Error(`${file}: line 1 must be the header {contract, runId}`);
      return;
    }
    const s = toSummary(v as Design);
    summaries.push(s);
    at.set(s.id, { offset, length });
  });
  if (!header) throw new Error(`${file}: empty`);
  return { header, summaries, at };
}

export function toSummary(d: Design): DesignSummary {
  const { decisions: _d, rawDecisions: _r, ...s } = d;
  return s;
}

/** writes a designs.jsonl file line by line (no single big string) */
export function writeDesignsJsonl(file: string, header: DesignStreamHeader, designs: Iterable<Design>) {
  const fd = fs.openSync(file, 'w');
  try {
    let pending: string[] = [JSON.stringify(header)];
    let size = pending[0].length;
    const flush = () => { if (pending.length) fs.writeSync(fd, pending.join('\n') + '\n'); pending = []; size = 0; };
    for (const d of designs) {
      const line = JSON.stringify(d);
      pending.push(line);
      size += line.length;
      if (size > 4 << 20) flush();
    }
    flush();
  } finally {
    fs.closeSync(fd);
  }
}
