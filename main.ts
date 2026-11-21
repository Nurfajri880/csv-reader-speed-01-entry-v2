// main.ts v3 — the harness driver, byte edition.
//
// It reads /input/cases.json as raw bytes, extracts each case's text (still
// JSON-escaped) and header with a structural scan, answers each case with
// run() from solve.js (which transcodes the escaped bytes straight to answer
// JSON), and writes /output/answers.json. No JSON.parse, no JSON.stringify.
//
// The cases file is written by the harness as compact JSON in a fixed shape:
// [{"id":"...","input":{"text":"...","header":true}}, ...]. The scan follows
// that shape (tolerating whitespace). If the shape ever differs, it falls
// back to the standard driver (JSON.parse + run on strings), so correctness
// never depends on the scan.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules allow an entry to tune V8's flags the same
// way as the baseline).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run, runTransduce } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown; runTransduce: (casesBuf: Buffer) => Buffer | null };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const BS = 0x5c;
const DQ = 0x22;
const CM = 0x2c;

type CaseBytes = { text: Buffer; header: boolean };

/** Extract every case's raw text bytes + header from the cases file. Throws on any shape mismatch. */
function parseCases(raw: Buffer): CaseBytes[] {
  const n = raw.length;
  let pos = 0;
  const skipWs = (): void => {
    while (pos < n) {
      const c = raw[pos];
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };
  const expectByte = (v: number): void => {
    skipWs();
    if (raw[pos] !== v) throw new Error('cases: unexpected byte');
    pos++;
  };
  const expectStr = (s: string): void => {
    skipWs();
    for (let i = 0; i < s.length; i++) {
      if (raw[pos + i] !== s.charCodeAt(i)) throw new Error('cases: unexpected token');
    }
    pos += s.length;
  };
  // Skip a JSON string starting at pos (pos is at the opening quote). Returns
  // the position just past its closing quote.
  const skipString = (): number => {
    if (raw[pos] !== DQ) throw new Error('cases: expected string');
    pos++;
    while (true) {
      const q = raw.indexOf(DQ, pos);
      if (q === -1) throw new Error('cases: unterminated string');
      let bs = 0;
      for (let i = q - 1; i >= pos && raw[i] === BS; i--) bs++;
      if (bs % 2 === 0) { pos = q + 1; return pos; }
      pos = q + 1;
    }
  };
  // Read a JSON string starting at pos; return its content byte range.
  const readText = (): [number, number] => {
    if (raw[pos] !== DQ) throw new Error('cases: expected string');
    const start = pos + 1;
    pos = start;
    while (true) {
      const q = raw.indexOf(DQ, pos);
      if (q === -1) throw new Error('cases: unterminated string');
      let bs = 0;
      for (let i = q - 1; i >= start && raw[i] === BS; i--) bs++;
      if (bs % 2 === 0) { pos = q + 1; return [start, q]; }
      pos = q + 1;
    }
  };
  const readBool = (): boolean => {
    skipWs();
    if (raw[pos] === 0x74 && raw[pos + 1] === 0x72 && raw[pos + 2] === 0x75 && raw[pos + 3] === 0x65) { pos += 4; return true; } // true
    if (raw[pos] === 0x66 && raw[pos + 1] === 0x61 && raw[pos + 2] === 0x6c && raw[pos + 3] === 0x73 && raw[pos + 4] === 0x65) { pos += 5; return false; } // false
    throw new Error('cases: expected boolean');
  };

  expectByte(0x5b); // [
  const cases: CaseBytes[] = [];
  skipWs();
  if (raw[pos] === 0x5d) return cases; // []
  while (true) {
    expectByte(0x7b); // {
    expectStr('"id"');
    expectByte(0x3a); // :
    skipString();
    expectByte(CM);
    expectStr('"input"');
    expectByte(0x3a); // :
    expectByte(0x7b); // {
    expectStr('"text"');
    expectByte(0x3a); // :
    const [ts, te] = readText();
    expectByte(CM);
    expectStr('"header"');
    expectByte(0x3a); // :
    const header = readBool();
    expectByte(0x7d); // }
    expectByte(0x7d); // }
    cases.push({ text: raw.subarray(ts, te), header });
    skipWs();
    if (raw[pos] === CM) { pos++; continue; }
    if (raw[pos] === 0x5d) { pos++; break; } // ]
    throw new Error('cases: expected , or ]');
  }
  return cases;
}

const raw = readFileSync(join(INPUT_DIR, 'cases.json'));

let wrote = false;
// Fast path: the WASM JSON-to-JSON transducer does the whole file in one pass
// (find cases, parse CSV with SIMD, stream answers.json). Falls back below if
// the shape differs or WASM is unavailable.
try {
  const out = runTransduce(raw);
  if (out !== null) {
    writeFileSync(join(OUTPUT_DIR, 'answers.json'), out);
    wrote = true;
  }
} catch {
  // fall through to the per-case path
}
if (!wrote) {
try {
  const cases = parseCases(raw);
  const parts: Buffer[] = [Buffer.from('[')];
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) parts.push(Buffer.from(','));
    parts.push(run({ text: cases[i].text, header: cases[i].header }) as Buffer);
  }
  parts.push(Buffer.from(']'));
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), Buffer.concat(parts));
  wrote = true;
} catch {
  // The shape differed from the expected compact JSON: fall back to the
  // standard driver (JSON.parse + run on strings). Correctness first.
}
}

if (!wrote) {
  const cases = JSON.parse(raw.toString('utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
}
