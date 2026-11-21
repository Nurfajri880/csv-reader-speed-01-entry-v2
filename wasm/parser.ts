// parser.ts — csv-reader 1.0.0 byte-transcoder, compiled to WebAssembly.
//
// A port of solve.js runBytes (the JS byte path) to AssemblyScript, so the
// hot loop runs as WASM: no JS per-field overhead, no GC, direct memory.copy
// for field bytes, scalar byte scanning (SIMD to come if the benchmark says
// the scan is the bottleneck).
//
// Memory layout (linear memory, initial 512 pages = 32 MiB, never grown):
//   input  : 0 .. inputLen            (written by JS before the call)
//   output : outPtr ..                (written by this module; JS reads it back)
//   SPANS  : 24 MiB, 3 x i32 per span (start, end, before), 64 KiB
//   FMETA  : 24 MiB + 64 KiB, 4 x i32 per field, 16 KiB
//   ERRS   : 24 MiB + 80 KiB, 5 x i32 per error, 256 KiB
//   EXTRA  : 24 MiB + 336 KiB, bump allocator for long_row `extra` JSON, 1 MiB
//
// A span is [start, end, before]; before is 0 = nothing, 1 = \" , 2 = \n.
// A span with start == -1 emits only its `before` (a literal quote from an
// unterminated opening quote). Spans are split at every transform point, so
// every span's bytes are copied verbatim with memory.copy.
// An error is [code, line, row, arg1, arg2]; code: 0 stray_cr, 1 quote_junk,
// 2 unterminated_quote, 3 short_row, 4 long_row. row is -1 for null.
// For short_row arg1 = field count; for long_row arg1/arg2 = extra ptr/len.

const BS: i32 = 0x5c;
const DQ: i32 = 0x22;
const CM: i32 = 0x2c;
const CH_N: i32 = 0x6e;
const CH_R: i32 = 0x72;
const CH_U: i32 = 0x75;

const COMMA: i32 = 0;
const LINE_BREAK: i32 = 1;
const END: i32 = 2;

const SP_NONE: i32 = 0;
const SP_QUOTE: i32 = 1;
const SP_LF: i32 = 2;

const ERR_STRAY_CR: i32 = 0;
const ERR_QUOTE_JUNK: i32 = 1;
const ERR_UNTERMINATED: i32 = 2;
const ERR_SHORT_ROW: i32 = 3;
const ERR_LONG_ROW: i32 = 4;

const SPANS: i32 = 24 * 1024 * 1024;
const FMETA: i32 = SPANS + 65536;
const ERRS: i32 = FMETA + 16384;
const EXTRA: i32 = ERRS + 262144;
const SCRATCH: i32 = EXTRA + 1048576; // 16-byte scratch for number rendering

// Input and output pointers (set by parseCase).
let buf: i32 = 0; // input base
let n: i32 = 0;   // input length
let o: i32 = 0;   // output cursor (absolute)

// Parser state.
let p: i32 = 0;
let line: i32 = 1;
let recordLine: i32 = 1;
let recordRow: i32 = 0;
let width: i32 = -1;
let headerFlag: i32 = 0;
let headerSeen: bool = false;
let rowCount: i32 = 0;
let spansLen: i32 = 0; // number of numbers in the flat spans array
let fmetaLen: i32 = 0; // number of numbers in the flat fmeta array
let errCount: i32 = 0;
let extraPtr: i32 = 0; // bump cursor in EXTRA
let fend: i32 = END;
let fquoted: bool = false;
let fempty: bool = true;
let fjunk: bool = false;

// ---- SIMD helpers (v128, 16 bytes at a time) ----
// Find the next ',' (0x2c) or '\' (0x5c) at or after p, before end. Returns the position, or end.
function findDelim(p: i32, end: i32): i32 {
  const comma: v128 = i8x16.splat(i8(CM));
  const bs: v128 = i8x16.splat(i8(BS));
  let q: i32 = p;
  while (q + 16 <= end) {
    const v: v128 = v128.load(changetype<usize>(q));
    const m: i32 = i8x16.bitmask(v128.or(i8x16.eq(v, comma), i8x16.eq(v, bs)));
    if (m != 0) return q + i32.ctz(m);
    q += 16;
  }
  while (q < end) {
    const c: i32 = load<u8>(q);
    if (c == CM || c == BS) return q;
    q++;
  }
  return end;
}

// Find the next '\' (0x5c) at or after p, before end. Returns the position, or end.
function findBS(p: i32, end: i32): i32 {
  const bs: v128 = i8x16.splat(i8(BS));
  let q: i32 = p;
  while (q + 16 <= end) {
    const v: v128 = v128.load(changetype<usize>(q));
    const m: i32 = i8x16.bitmask(i8x16.eq(v, bs));
    if (m != 0) return q + i32.ctz(m);
    q += 16;
  }
  while (q < end) {
    if (load<u8>(q) == BS) return q;
    q++;
  }
  return end;
}

// Find the next '"' (0x22) at or after p, before end. Returns the position, or end.
function findQuote(p: i32, end: i32): i32 {
  const dq: v128 = i8x16.splat(i8(DQ));
  let q: i32 = p;
  while (q + 16 <= end) {
    const v: v128 = v128.load(changetype<usize>(q));
    const m: i32 = i8x16.bitmask(i8x16.eq(v, dq));
    if (m != 0) return q + i32.ctz(m);
    q += 16;
  }
  while (q < end) {
    if (load<u8>(q) == DQ) return q;
    q++;
  }
  return end;
}

// Find the literal `"text":"` at or after pos. Returns the position just after
// the opening quote of the text value, or -1.
function findTextValue(pos: i32, end: i32): i32 {
  let q: i32 = pos;
  while (true) {
    q = findQuote(q, end);
    if (q >= end) return -1;
    if (q + 8 <= end &&
        load<u8>(q + 1) == 0x74 && load<u8>(q + 2) == 0x65 && load<u8>(q + 3) == 0x78 &&
        load<u8>(q + 4) == 0x74 && load<u8>(q + 5) == DQ && load<u8>(q + 6) == 0x3a &&
        load<u8>(q + 7) == DQ) {
      return q + 8;
    }
    q += 1;
  }
}

// Find the closing quote of a JSON string whose content starts at pos.
// Returns the position of the closing quote, or -1.
function findTextEnd(pos: i32, end: i32): i32 {
  let q: i32 = pos;
  while (true) {
    q = findQuote(q, end);
    if (q >= end) return -1;
    let bsc: i32 = 0;
    let i: i32 = q - 1;
    while (i >= pos && load<u8>(i) == BS) { bsc++; i--; }
    if (bsc % 2 == 0) return q;
    q += 1;
  }
}

// Find `"header":` at or after pos. Returns 1 for true, 0 for false, -1 if not found.
function findHeader(pos: i32, end: i32): i32 {
  let q: i32 = pos;
  while (true) {
    q = findQuote(q, end);
    if (q >= end) return -1;
    if (q + 9 <= end &&
        load<u8>(q + 1) == 0x68 && load<u8>(q + 2) == 0x65 && load<u8>(q + 3) == 0x61 &&
        load<u8>(q + 4) == 0x64 && load<u8>(q + 5) == 0x65 && load<u8>(q + 6) == 0x72 &&
        load<u8>(q + 7) == DQ && load<u8>(q + 8) == 0x3a) {
      let r: i32 = q + 9;
      while (r < end && (load<u8>(r) == 0x20 || load<u8>(r) == 0x09 || load<u8>(r) == 0x0a || load<u8>(r) == 0x0d)) r++;
      if (r < end && load<u8>(r) == 0x74) return 1;
      if (r < end && load<u8>(r) == 0x66) return 0;
      return -1;
    }
    q += 1;
  }
}

function mcopy(dst: i32, src: i32, len: i32): void {
  if (len <= 0) return;
  memory.copy(changetype<usize>(dst), changetype<usize>(src), changetype<usize>(len));
}

function wByte(v: i32): void {
  store<u8>(o, v);
  o += 1;
}

function wStr2(a: i32, b: i32): void {
  store<u8>(o, a);
  store<u8>(o + 1, b);
  o += 2;
}

// Write a non-negative decimal integer.
function wI32(v: i32): void {
  if (v == 0) {
    wByte(48);
    return;
  }
  let tmp: i32 = SCRATCH + 16; // digits go backwards from here
  let d: i32 = 0;
  let x: i32 = v;
  while (x > 0) {
    tmp -= 1;
    store<u8>(tmp, 48 + (x % 10));
    x = x / 10;
    d += 1;
  }
  mcopy(o, tmp, d);
  o += d;
}

function errPush(code: i32, arg1: i32, arg2: i32): void {
  const e: i32 = ERRS + errCount * 20;
  store<i32>(e, code);
  store<i32>(e + 4, recordLine);
  store<i32>(e + 8, recordRow);
  store<i32>(e + 12, arg1);
  store<i32>(e + 16, arg2);
  errCount += 1;
}

function error(code: i32): void {
  errPush(code, 0, 0);
}

function spanPush(a: i32, b: i32, before: i32): void {
  const s: i32 = SPANS + spansLen * 4;
  store<i32>(s, a);
  store<i32>(s + 4, b);
  store<i32>(s + 8, before);
  spansLen += 3;
}

function emitField(fi: i32): void {
  const s0: i32 = load<i32>(FMETA + fi * 16);
  const sc: i32 = load<i32>(FMETA + fi * 16 + 4);
  wByte(DQ);
  for (let k: i32 = 0; k < sc; k++) {
    const a: i32 = load<i32>(SPANS + (s0 + k * 3) * 4);
    const b: i32 = load<i32>(SPANS + (s0 + k * 3 + 1) * 4);
    const before: i32 = load<i32>(SPANS + (s0 + k * 3 + 2) * 4);
    if (before == SP_QUOTE) wStr2(BS, DQ);
    else if (before == SP_LF) wStr2(BS, CH_N);
    if (a != -1) mcopy(o, a, b - a), o += b - a;
  }
  wByte(DQ);
}

function emitRecord(count: i32, padTo: i32): void {
  wByte(0x5b);
  for (let i: i32 = 0; i < count; i++) {
    if (i > 0) wByte(CM);
    emitField(i);
  }
  for (let i: i32 = count; i < padTo; i++) {
    if (i > 0) wByte(CM);
    wStr2(DQ, DQ);
  }
  wByte(0x5d);
}

// Render one field's JSON into the EXTRA bump area; returns its length.
function fieldToExtra(fi: i32): i32 {
  const start: i32 = extraPtr;
  const s0: i32 = load<i32>(FMETA + fi * 16);
  const sc: i32 = load<i32>(FMETA + fi * 16 + 4);
  store<u8>(extraPtr, DQ);
  extraPtr += 1;
  for (let k: i32 = 0; k < sc; k++) {
    const a: i32 = load<i32>(SPANS + (s0 + k * 3) * 4);
    const b: i32 = load<i32>(SPANS + (s0 + k * 3 + 1) * 4);
    const before: i32 = load<i32>(SPANS + (s0 + k * 3 + 2) * 4);
    if (before == SP_QUOTE) {
      store<u8>(extraPtr, BS);
      store<u8>(extraPtr + 1, DQ);
      extraPtr += 2;
    } else if (before == SP_LF) {
      store<u8>(extraPtr, BS);
      store<u8>(extraPtr + 1, CH_N);
      extraPtr += 2;
    }
    if (a != -1) {
      mcopy(extraPtr, a, b - a);
      extraPtr += b - a;
    }
  }
  store<u8>(extraPtr, DQ);
  extraPtr += 1;
  return extraPtr - start;
}

// Unquoted reader: scans from p, appending spans, until ',', a line break,
// or the end of the text. `contentSoFar` says whether the value already
// holds a character; `forJunk` tracks junk content (for quote_junk).
function readUnquoted(contentSoFar: bool, forJunk: bool): void {
  let segStart: i32 = p;
  let hasContent: bool = contentSoFar;
  let junkContent: bool = false;
  while (p < n) {
    // SIMD skip: jump over ordinary content to the next ',' or '\'.
    const q: i32 = findDelim(p, n);
    if (q > p) {
      hasContent = true;
      if (forJunk) junkContent = true;
      p = q;
      if (p >= n) break;
    }
    const c: i32 = load<u8>(p);
    if (c == CM) {
      if (p > segStart) {
        spanPush(segStart, p, SP_NONE);
        hasContent = true;
        if (forJunk) junkContent = true;
      }
      fend = COMMA;
      p += 1;
      fempty = !hasContent;
      fjunk = junkContent;
      return;
    }
    if (c == BS) {
      const e: i32 = load<u8>(p + 1);
      if (e == CH_N) {
        if (p > segStart) {
          spanPush(segStart, p, SP_NONE);
          hasContent = true;
          if (forJunk) junkContent = true;
        }
        fend = LINE_BREAK;
        p += 2;
        line += 1;
        fempty = !hasContent;
        fjunk = junkContent;
        return;
      }
      if (e == CH_R) {
        if (load<u8>(p + 2) == BS && load<u8>(p + 3) == CH_N) {
          if (p > segStart) {
            spanPush(segStart, p, SP_NONE);
            hasContent = true;
            if (forJunk) junkContent = true;
          }
          fend = LINE_BREAK;
          p += 4;
          line += 1;
          fempty = !hasContent;
          fjunk = junkContent;
          return;
        }
        error(ERR_STRAY_CR);
        if (p > segStart) {
          spanPush(segStart, p, SP_NONE);
          hasContent = true;
          if (forJunk) junkContent = true;
        }
        segStart = p + 2;
        p += 2;
        continue;
      }
      // Any other escape is literal content.
      hasContent = true;
      if (forJunk) junkContent = true;
      p += (e == CH_U) ? 6 : 2;
      continue;
    }
    // Unreachable: findDelim only stops at ',' or '\' (or n).
    p += 1;
  }
  // End of text.
  if (n > segStart) {
    spanPush(segStart, n, SP_NONE);
    hasContent = true;
    if (forJunk) junkContent = true;
  }
  fend = END;
  p = n;
  fempty = !hasContent;
  fjunk = junkContent;
}

// Quoted reader: p is at the opening \" .
function readQuoted(): void {
  const open: i32 = p;
  const openLine: i32 = line;
  const fieldSpans: i32 = spansLen;
  let segStart: i32 = p + 2;
  let pending: i32 = SP_NONE;
  p += 2;
  while (p < n) {
    // SIMD skip: jump over quoted content to the next '\'.
    const q: i32 = findBS(p, n);
    if (q > p) { p = q; if (p >= n) break; }
    const c: i32 = load<u8>(p);
    if (c != BS) {
      p += 1;
      continue;
    }
    const e: i32 = load<u8>(p + 1);
    if (e == DQ) {
      if (load<u8>(p + 2) == BS && load<u8>(p + 3) == DQ) {
        if (p > segStart) spanPush(segStart, p, pending);
        else if (pending != SP_NONE) spanPush(-1, -1, pending);
        pending = SP_QUOTE;
        segStart = p + 4;
        p += 4;
        continue;
      }
      // Closing quote.
      if (p > segStart) spanPush(segStart, p, pending);
      else if (pending != SP_NONE) spanPush(-1, -1, pending);
      fquoted = true;
      p += 2;
      if (p >= n) {
        fend = END;
        return;
      }
      if (load<u8>(p) == CM) {
        fend = COMMA;
        p += 1;
        return;
      }
      if (load<u8>(p) == BS && load<u8>(p + 1) == CH_N) {
        fend = LINE_BREAK;
        p += 2;
        line += 1;
        return;
      }
      if (load<u8>(p) == BS && load<u8>(p + 1) == CH_R && load<u8>(p + 2) == BS && load<u8>(p + 3) == CH_N) {
        fend = LINE_BREAK;
        p += 4;
        line += 1;
        return;
      }
      readUnquoted(true, true);
      if (fjunk) error(ERR_QUOTE_JUNK);
      return;
    }
    if (e == CH_N) {
      if (p > segStart) spanPush(segStart, p, pending);
      else if (pending != SP_NONE) spanPush(-1, -1, pending);
      pending = SP_LF;
      segStart = p + 2;
      p += 2;
      line += 1;
      continue;
    }
    if (e == CH_R) {
      const isCRLF: bool = load<u8>(p + 2) == BS && load<u8>(p + 3) == CH_N;
      if (p > segStart) spanPush(segStart, p, pending);
      else if (pending != SP_NONE) spanPush(-1, -1, pending);
      pending = SP_LF;
      segStart = isCRLF ? p + 4 : p + 2;
      p = segStart;
      line += 1;
      continue;
    }
    // Any other escape is literal content.
    p += (e == CH_U) ? 6 : 2;
  }
  // The quote never closes: it is a literal character, and the text after
  // it is read again as unquoted. Nothing scanned as quoted content counts.
  spansLen = fieldSpans;
  p = open + 2;
  line = openLine;
  error(ERR_UNTERMINATED);
  spanPush(-1, -1, SP_QUOTE);
  fquoted = true;
  readUnquoted(true, false);
}

// Emit the collected errors as JSON.
function emitErrors(): void {
  wByte(0x5d); // ]
  wStr2(0x2c, 0x22); // ,"
  // ,"errors":[
  store<u8>(o, 0x65); store<u8>(o + 1, 0x72); store<u8>(o + 2, 0x72);
  store<u8>(o + 3, 0x6f); store<u8>(o + 4, 0x72); store<u8>(o + 5, 0x73);
  store<u8>(o + 6, 0x22); store<u8>(o + 7, 0x3a); store<u8>(o + 8, 0x5b);
  o += 9;
  for (let i: i32 = 0; i < errCount; i++) {
    const e: i32 = ERRS + i * 20;
    const code: i32 = load<i32>(e);
    const eline: i32 = load<i32>(e + 4);
    const erow: i32 = load<i32>(e + 8);
    const arg1: i32 = load<i32>(e + 12);
    const arg2: i32 = load<i32>(e + 16);
    if (i > 0) wByte(CM);
    wByte(0x7b); // {
    // "code":"<name>","line":N,"row":R
    wStr2(DQ, 0x63); store<u8>(o, 0x6f); store<u8>(o + 1, 0x64); store<u8>(o + 2, 0x65); o += 3;
    wStr2(DQ, 0x3a); wByte(DQ);
    if (code == ERR_STRAY_CR) {
      store<u8>(o, 0x73); store<u8>(o + 1, 0x74); store<u8>(o + 2, 0x72); store<u8>(o + 3, 0x61); store<u8>(o + 4, 0x79); store<u8>(o + 5, 0x5f); store<u8>(o + 6, 0x63); store<u8>(o + 7, 0x72); o += 8;
    } else if (code == ERR_QUOTE_JUNK) {
      store<u8>(o, 0x71); store<u8>(o + 1, 0x75); store<u8>(o + 2, 0x6f); store<u8>(o + 3, 0x74); store<u8>(o + 4, 0x65); store<u8>(o + 5, 0x5f); store<u8>(o + 6, 0x6a); store<u8>(o + 7, 0x75); store<u8>(o + 8, 0x6e); store<u8>(o + 9, 0x6b); o += 10;
    } else if (code == ERR_UNTERMINATED) {
      store<u8>(o, 0x75); store<u8>(o + 1, 0x6e); store<u8>(o + 2, 0x74); store<u8>(o + 3, 0x65); store<u8>(o + 4, 0x72); store<u8>(o + 5, 0x6d); store<u8>(o + 6, 0x69); store<u8>(o + 7, 0x6e); store<u8>(o + 8, 0x61); store<u8>(o + 9, 0x74); store<u8>(o + 10, 0x65); store<u8>(o + 11, 0x64); store<u8>(o + 12, 0x5f); store<u8>(o + 13, 0x71); store<u8>(o + 14, 0x75); store<u8>(o + 15, 0x6f); store<u8>(o + 16, 0x74); store<u8>(o + 17, 0x65); o += 18;
    } else if (code == ERR_SHORT_ROW) {
      store<u8>(o, 0x73); store<u8>(o + 1, 0x68); store<u8>(o + 2, 0x6f); store<u8>(o + 3, 0x72); store<u8>(o + 4, 0x74); store<u8>(o + 5, 0x5f); store<u8>(o + 6, 0x72); store<u8>(o + 7, 0x6f); store<u8>(o + 8, 0x77); o += 9;
    } else {
      store<u8>(o, 0x6c); store<u8>(o + 1, 0x6f); store<u8>(o + 2, 0x6e); store<u8>(o + 3, 0x67); store<u8>(o + 4, 0x5f); store<u8>(o + 5, 0x72); store<u8>(o + 6, 0x6f); store<u8>(o + 7, 0x77); o += 8;
    }
    wByte(DQ);
    wStr2(CM, DQ); store<u8>(o, 0x6c); store<u8>(o + 1, 0x69); store<u8>(o + 2, 0x6e); store<u8>(o + 3, 0x65); o += 4;
    wStr2(DQ, 0x3a);
    wI32(eline);
    wStr2(CM, DQ); store<u8>(o, 0x72); store<u8>(o + 1, 0x6f); store<u8>(o + 2, 0x77); o += 3;
    wStr2(DQ, 0x3a);
    if (erow == -1) {
      store<u8>(o, 0x6e); store<u8>(o + 1, 0x75); store<u8>(o + 2, 0x6c); store<u8>(o + 3, 0x6c); o += 4;
    } else {
      wI32(erow);
    }
    if (code == ERR_SHORT_ROW) {
      wStr2(CM, DQ);
      store<u8>(o, 0x66); store<u8>(o + 1, 0x69); store<u8>(o + 2, 0x65); store<u8>(o + 3, 0x6c); store<u8>(o + 4, 0x64); store<u8>(o + 5, 0x73); o += 6;
      wStr2(DQ, 0x3a);
      wI32(arg1);
    } else if (code == ERR_LONG_ROW) {
      wStr2(CM, DQ);
      store<u8>(o, 0x65); store<u8>(o + 1, 0x78); store<u8>(o + 2, 0x74); store<u8>(o + 3, 0x72); store<u8>(o + 4, 0x61); o += 5;
      wStr2(DQ, 0x3a);
      mcopy(o, arg1, arg2);
      o += arg2;
    }
    wByte(0x7d); // }
  }
  wByte(0x5d); // ]
  wByte(0x7d); // }
}

// Parse one case. Assumes buf/n (input range, absolute), o (output cursor),
// headerFlag are already set. Resets per-case state, writes the case's answer
// JSON at o, advances o. No guard write (the transducer parses each case at
// its own address in cases.json, so there are no leftovers to mask).
function parseBody(): void {
  p = buf;
  line = 1;
  width = -1;
  headerSeen = false;
  rowCount = 0;
  errCount = 0;
  extraPtr = EXTRA;
  // A U+FEFF at the very start is dropped (EF BB BF in UTF-8).
  if (n - buf >= 3 && load<u8>(buf) == 0xef && load<u8>(buf + 1) == 0xbb && load<u8>(buf + 2) == 0xbf) p = buf + 3;
  // {"columns":
  store<u8>(o, 0x7b); store<u8>(o + 1, DQ); store<u8>(o + 2, 0x63); store<u8>(o + 3, 0x6f);
  store<u8>(o + 4, 0x6c); store<u8>(o + 5, 0x75); store<u8>(o + 6, 0x6d); store<u8>(o + 7, 0x6e);
  store<u8>(o + 8, 0x73); store<u8>(o + 9, DQ); store<u8>(o + 10, 0x3a);
  o += 11;
  let rowsStarted: bool = false;
  if (headerFlag == 0) {
    store<u8>(o, 0x6e); store<u8>(o + 1, 0x75); store<u8>(o + 2, 0x6c); store<u8>(o + 3, 0x6c);
    store<u8>(o + 4, CM); store<u8>(o + 5, DQ);
    store<u8>(o + 6, 0x72); store<u8>(o + 7, 0x6f); store<u8>(o + 8, 0x77); store<u8>(o + 9, 0x73);
    store<u8>(o + 10, DQ); store<u8>(o + 11, 0x3a); store<u8>(o + 12, 0x5b);
    o += 13;
    rowsStarted = true;
  }

  while (true) {
    // Lines with no characters are no records.
    while (p < n) {
      if (load<u8>(p) == BS && load<u8>(p + 1) == CH_N) {
        p += 2;
        line += 1;
      } else if (load<u8>(p) == BS && load<u8>(p + 1) == CH_R && load<u8>(p + 2) == BS && load<u8>(p + 3) == CH_N) {
        p += 4;
        line += 1;
      } else {
        break;
      }
    }
    if (p >= n) break;

    recordLine = line;
    recordRow = (headerFlag == 1 && !headerSeen) ? -1 : rowCount;
    spansLen = 0;
    fmetaLen = 0;
    do {
      const s0: i32 = spansLen;
      if (load<u8>(p) == BS && load<u8>(p + 1) == DQ) {
        readQuoted();
      } else {
        fquoted = false;
        readUnquoted(false, false);
      }
      const f: i32 = FMETA + fmetaLen * 4;
      store<i32>(f, s0);
      store<i32>(f + 4, (spansLen - s0) / 3);
      store<i32>(f + 8, fquoted ? 1 : 0);
      store<i32>(f + 12, fempty ? 1 : 0);
      fmetaLen += 4;
    } while (fend == COMMA);

    const fieldCount: i32 = fmetaLen / 4;

    // A line that held only stray CRs is left with no characters: no record.
    if (fieldCount == 1 && load<i32>(FMETA + 12) == 1 && load<i32>(FMETA + 8) == 0) continue;

    if (width < 0) width = fieldCount;
    if (headerFlag == 1 && !headerSeen) {
      headerSeen = true;
      emitRecord(fieldCount, fieldCount);
      store<u8>(o, CM); store<u8>(o + 1, DQ);
      store<u8>(o + 2, 0x72); store<u8>(o + 3, 0x6f); store<u8>(o + 4, 0x77); store<u8>(o + 5, 0x73);
      store<u8>(o + 6, DQ); store<u8>(o + 7, 0x3a); store<u8>(o + 8, 0x5b);
      o += 9;
      rowsStarted = true;
      continue;
    }
    if (fieldCount < width) {
      errPush(ERR_SHORT_ROW, fieldCount, 0);
    } else if (fieldCount > width) {
      // Render the extra fields' JSON array into EXTRA, then record it.
      const eStart: i32 = extraPtr;
      store<u8>(extraPtr, 0x5b);
      extraPtr += 1;
      for (let i: i32 = width; i < fieldCount; i++) {
        if (i > width) {
          store<u8>(extraPtr, CM);
          extraPtr += 1;
        }
        fieldToExtra(i);
      }
      store<u8>(extraPtr, 0x5d);
      extraPtr += 1;
      errPush(ERR_LONG_ROW, eStart, extraPtr - eStart);
    }
    if (rowCount > 0) wByte(CM);
    emitRecord(fieldCount < width ? fieldCount : width, width);
    rowCount++;
  }

  if (headerFlag == 1 && !headerSeen) {
    store<u8>(o, 0x5b); store<u8>(o + 1, 0x5d); // []
    store<u8>(o + 2, CM); store<u8>(o + 3, DQ);
    store<u8>(o + 4, 0x72); store<u8>(o + 5, 0x6f); store<u8>(o + 6, 0x77); store<u8>(o + 7, 0x73);
    store<u8>(o + 8, DQ); store<u8>(o + 9, 0x3a); store<u8>(o + 10, 0x5b);
    o += 11;
    rowsStarted = true;
  }
  void rowsStarted;
  emitErrors();
}

export function parseCase(inputPtr: i32, inputLen: i32, header: i32, outPtr: i32): i32 {
  buf = inputPtr;
  n = inputPtr + inputLen;
  o = outPtr;
  headerFlag = header;
  // Guard: the parser looks ahead up to 3 bytes past the input end (CRLF and
  // doubled-quote checks). Zero those bytes so a previous, longer case's
  // leftovers cannot be misread as an escape.
  for (let g: i32 = 0; g < 16; g++) store<u8>(n + g, 0);
  const start: i32 = o;
  parseBody();
  return o - start;
}

// JSON-to-JSON transducer: the whole cases.json is at casesPtr (absolute),
// length casesLen. Finds each case's "text" and "header", parses it, and
// streams the full answers.json to outPtr. Returns the output length, or -1
// if the JSON shape is not the expected compact form (caller falls back).
// No guard writes: each case is parsed in place, and the lookahead past a
// text's end reads the JSON structure bytes that follow it.
export function transduce(casesPtr: i32, casesLen: i32, outPtr: i32): i32 {
  const end: i32 = casesPtr + casesLen;
  let pos: i32 = casesPtr;
  o = outPtr;
  wByte(0x5b); // [
  let first: bool = true;
  while (true) {
    const ts: i32 = findTextValue(pos, end);
    if (ts < 0) break;
    const te: i32 = findTextEnd(ts, end);
    if (te < 0) return -1;
    const hdr: i32 = findHeader(te, end);
    if (hdr < 0) return -1;
    if (!first) wByte(CM);
    first = false;
    buf = ts;
    n = te;
    headerFlag = hdr;
    parseBody();
    pos = te + 1;
  }
  if (first) return -1; // no cases found: unexpected shape
  wByte(0x5d); // ]
  return o - outPtr;
}
