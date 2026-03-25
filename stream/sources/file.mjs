// Source: reads a CSV file line-by-line using a file descriptor + byte offset.
// Never loads the entire file into memory.
//
// Source interface (async):
//   init()            → Promise<void>    open file, read header
//   header()          → string           CSV header line (available after init)
//   next(mode)        → Promise<string[] | null>   next chunk, null at EOF
//   reset()           → Promise<void>    seek back to first data row
//   close()           → void             release file descriptor

import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

export function createFileSource(filepath, opts = {}) {
  const path = resolve(filepath);
  const follow = opts.follow ?? false; // when true, EOF means "wait for more" not "done"
  let fh = null;           // file handle
  let _header = null;
  let dataOffset = 0;      // byte offset where data rows begin (after header + newline)
  let offset = 0;          // current read position
  let remainder = '';       // leftover bytes from last read that didn't end with \n

  const BUF_SIZE = 4096;

  // Read the next raw line from the file. Returns null at EOF.
  // In follow mode, a partial line (no trailing newline) is kept in remainder
  // rather than flushed, since the writer may not have finished the line yet.
  async function readLine() {
    while (true) {
      const nlIdx = remainder.indexOf('\n');
      if (nlIdx !== -1) {
        const line = remainder.slice(0, nlIdx).trimEnd();
        remainder = remainder.slice(nlIdx + 1);
        if (line.length > 0) return line;
        continue; // skip empty lines
      }

      // Need more data
      const buf = Buffer.alloc(BUF_SIZE);
      const { bytesRead } = await fh.read(buf, 0, BUF_SIZE, offset);
      if (bytesRead === 0) {
        if (follow) {
          // Don't flush remainder — it may be a partially written line.
          // Caller will retry on the next interval.
          return null;
        }
        // Not following — flush remainder as final line
        if (remainder.trim().length > 0) {
          const last = remainder.trim();
          remainder = '';
          return last;
        }
        return null;
      }
      offset += bytesRead;
      remainder += buf.toString('utf8', 0, bytesRead);
    }
  }

  return {
    async init() {
      fh = await open(path, 'r');
      offset = 0;
      remainder = '';
      _header = await readLine();
      dataOffset = offset - Buffer.byteLength(remainder, 'utf8');
    },

    header() {
      return _header;
    },

    // next(mode):
    //   "line" → returns a single-element array [row]
    //   "tick" → returns all consecutive rows sharing the same t value
    async next(mode = 'line') {
      const first = await readLine();
      if (first === null) return follow ? [] : null;

      if (mode === 'line') return [first];

      // tick mode: collect all rows with the same t value
      const t = first.split(',', 1)[0];
      const batch = [first];

      // Peek ahead for more rows with the same t
      while (true) {
        const savedOffset = offset;
        const savedRemainder = remainder;
        const row = await readLine();
        if (row === null) break;

        if (row.split(',', 1)[0] === t) {
          batch.push(row);
        } else {
          // Different t — put it back by restoring state
          offset = savedOffset;
          remainder = savedRemainder;
          break;
        }
      }
      return batch;
    },

    async reset() {
      offset = dataOffset;
      remainder = '';
    },

    close() {
      if (fh) { fh.close(); fh = null; }
    },
  };
}
