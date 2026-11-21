// solve.js v3 — csv-reader 1.0.0 drop-in, byte-transcoder edition.
//
// Two paths, one semantics (both return exactly csv-reader 1.0.0's answer):
// - runString(input): the v2 indexOf/slice parser on a JS string. Kept verbatim as the
//   reference implementation and the contract path (input.text is a string).
// - runBytes(textBuf, header): the fast path. input.text is the RAW ESCAPED bytes of the
//   case's JSON string (as it sits in cases.json). It parses the CSV straight from those
//   bytes and emits the case's answer as serialized JSON bytes — no JSON.parse of the
//   input, no row objects, no JSON.stringify, no per-field string allocation. Field
//   bytes are copied verbatim whenever the value needs no CSV transform, because the
//   input's JSON escaping already is the output's JSON escaping for the same characters.
//   runBytes prefers the WebAssembly build (wasm/parser.wasm, a port of the same
//   transcoder to AssemblyScript) and falls back to the JS transcoder below.
// - run(input) dispatches on the type of input.text. main.ts passes raw bytes.

import { readFileSync } from 'node:fs';

// ---- WebAssembly build (wasm/parser.wasm) ----
const WASM_OUT = 16 * 1024 * 1024;
let wasmInst = null;
let wasmMem = null;
try {
  const wasmBytes = readFileSync(new URL('./wasm/parser.wasm', import.meta.url));
  wasmInst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
  wasmMem = new Uint8Array(wasmInst.exports.memory.buffer);
} catch {
  wasmInst = null;
  wasmMem = null;
}

// ---- JSON-to-JSON transducer (single WASM pass) ----
// The whole cases.json goes in at address 0; transduce finds each case, parses
// it, and streams the full answers.json to TRANS_OUT. Returns a Buffer, or null
// if WASM is unavailable or the JSON shape is not the expected compact form.
const TRANS_OUT = 32 * 1024 * 1024; // 32 MiB; spans/meta end ~25.4 MiB, so no overlap
/** Whole-file transducer (exported for main.ts): cases.json bytes in, answers.json bytes out. */
export function runTransduce(casesBuf) {
  if (wasmInst === null) return null;
  if (typeof wasmInst.exports.transduce !== 'function') return null;
  wasmMem.set(casesBuf, 0);
  const len = wasmInst.exports.transduce(0, casesBuf.length, TRANS_OUT);
  if (len < 0) return null;
  return Buffer.from(wasmMem.subarray(TRANS_OUT, TRANS_OUT + len));
}

/** Fast path via WebAssembly; returns the answer JSON Buffer, or null if WASM is unavailable. */
function runBytesWasm(textBuf, header) {
  if (wasmInst === null) return null;
  wasmMem.set(textBuf, 0);
  const len = wasmInst.exports.parseCase(0, textBuf.length, header ? 1 : 0, WASM_OUT);
  return Buffer.from(wasmMem.subarray(WASM_OUT, WASM_OUT + len));
}
//
// Why the byte path is exact: in cases.json the CSV text is JSON-escaped, so the only
// escapes are \" (a CSV quote), \n (a CSV LF), \r (a CSV CR), plus \\ and \uXXXX in
// principle. A field's value needs a transform only for a doubled quote ("" -> ") or a
// CR/CRLF inside quotes (-> LF), or a stray CR outside quotes (dropped). Everything
// else in the field is already correctly JSON-escaped, so it is copied byte for byte.
// The scanner mirrors the v2 parser (and through it, csv-reader) step for step, and
// the byte path is verified against the string path on every test set.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Byte values in the escaped stream.
const BS = 0x5c; // backslash — introduces \", \n, \r, \\, \uXXXX
const DQ = 0x22; // "
const CM = 0x2c; // ,
const CH_N = 0x6e; // n (in \n)
const CH_R = 0x72; // r (in \r)
const CH_T = 0x74; // t (in \t)
const CH_B = 0x62; // b (in \b)
const CH_F = 0x66; // f (in \f)
const CH_SL = 0x2f; // / (in \/)
const CH_U = 0x75; // u (in \uXXXX)
const CH_BS = 0x5c; // \ (in \\)

/** csv-reader 1.0.0's answer for one case's input (string path, v2 — kept verbatim). */
export function runString(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let p = 0;    // the next character to read
  let line = 1; // the line p is on
  if (s.charCodeAt(0) === 0xFEFF) p = 1;

  let recordLine = 1;
  let recordRow = null;

  let fval = '';
  let fend = END;
  let fadded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  function readUnquotedSlow(value, added) {
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 44) { p += 1; fval = value; fend = COMMA; fadded = added; return; }
      if (c === 10) { p += 1; line += 1; fval = value; fend = LINE_BREAK; fadded = added; return; }
      if (c === 13) {
        if (s.charCodeAt(p + 1) === 10) { p += 2; line += 1; fval = value; fend = LINE_BREAK; fadded = added; return; }
        error('stray_cr');
        p += 1;
        continue;
      }
      value += s[p];
      added += 1;
      p += 1;
    }
    fval = value; fend = END; fadded = added;
  }

  function readQuoted() {
    const open = p;
    const openLine = line;
    let start = p + 1;
    let q = start;
    let parts = null;
    let close = -1;
    while (true) {
      const qi = s.indexOf('"', q);
      if (qi === -1) {
        p = open + 1;
        line = openLine;
        error('unterminated_quote');
        readUnquotedSlow('"', 0);
        return;
      }
      if (s.charCodeAt(qi + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(s.slice(start, qi + 1));
        q = qi + 2;
        start = qi + 2;
        continue;
      }
      close = qi;
      break;
    }
    let raw = parts === null ? s.slice(start, close) : parts.join('') + s.slice(start, close);
    if (raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1) {
      let add = 0;
      let i = 0;
      while ((i = raw.indexOf('\n', i)) !== -1) { add += 1; i += 1; }
      i = 0;
      while ((i = raw.indexOf('\r', i)) !== -1) { if (raw.charCodeAt(i + 1) !== 10) add += 1; i += 1; }
      line += add;
      if (raw.indexOf('\r') !== -1) raw = raw.replace(/\r\n?/g, '\n');
    }
    p = close + 1;
    if (p >= n) { fval = raw; fend = END; return; }
    const c = s.charCodeAt(p);
    if (c === 44) { p += 1; fval = raw; fend = COMMA; return; }
    if (c === 10) { p += 1; line += 1; fval = raw; fend = LINE_BREAK; return; }
    if (c === 13 && s.charCodeAt(p + 1) === 10) { p += 2; line += 1; fval = raw; fend = LINE_BREAK; return; }
    readUnquotedSlow(raw, 0);
    if (fadded > 0) error('quote_junk');
  }

  while (true) {
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 10) { p += 1; line += 1; }
      else if (c === 13 && s.charCodeAt(p + 1) === 10) { p += 2; line += 1; }
      else break;
    }
    if (p >= n) break;

    recordLine = line;
    recordRow = (header && columns === null) ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (s.charCodeAt(p) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        const fp = p;
        const fl = line;
        let c = s.indexOf(',', p);
        let l = s.indexOf('\n', p);
        if (c === -1) c = n;
        if (l === -1) l = n;
        if (c < l) {
          fval = s.slice(p, c);
          fend = COMMA;
          p = c + 1;
        } else if (l < c) {
          let ve = l;
          if (l > p && s.charCodeAt(l - 1) === 13) ve = l - 1;
          fval = s.slice(p, ve);
          fend = LINE_BREAK;
          p = l + 1;
          line += 1;
        } else {
          fval = s.slice(p, n);
          fend = END;
          p = n;
        }
        if (fval.indexOf('\r') !== -1) {
          p = fp;
          line = fl;
          readUnquotedSlow('', 0);
        }
      }
      fields.push(fval);
    } while (fend === COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// ---- Byte path ----

// A span is three numbers in the flat `spans` array: [start, end, before],
// where before is what to emit before this span's bytes:
//   0 = nothing, 1 = \" (one literal quote), 2 = \n (one LF).
// A span with start === -1 emits only its `before` (a literal quote from an
// unterminated opening quote). Spans are split at every transform point, so
// every span's bytes are copied verbatim.
const SP_BEFORE_NONE = 0;
const SP_BEFORE_QUOTE = 1;
const SP_BEFORE_LF = 2;

/** Fast path (JS transcoder): answer one case from the raw escaped bytes of its JSON text. Returns a Buffer holding the case's answer JSON. */
export function runBytesJS(textBuf, header) {
  const buf = textBuf;
  const n = buf.length;
  let p = 0;
  let line = 1;
  // A U+FEFF at the very start is dropped (EF BB BF in UTF-8).
  if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) p = 3;

  // Growable output buffer.
  let ob = Buffer.alloc(1 << 20);
  let op = 0;
  function need(k) {
    if (op + k <= ob.length) return;
    let nl = ob.length * 2;
    while (op + k > nl) nl *= 2;
    const nb = Buffer.alloc(nl);
    ob.copy(nb, 0, 0, op);
    ob = nb;
  }
  function wByte(v) { need(1); ob[op++] = v; }
  function wStr(s) { const l = Buffer.byteLength(s); need(l); ob.write(s, op, l, 'utf8'); op += l; }
  function wSlice(a, b) { const l = b - a; if (l <= 0) return; need(l); buf.copy(ob, op, a, b); op += l; }
  function wEscQuote() { need(2); ob[op++] = BS; ob[op++] = DQ; }
  function wEscLF() { need(2); ob[op++] = BS; ob[op++] = CH_N; }

  const errParts = []; // complete JSON objects, joined at the end
  let width = -1;
  let headerSeen = false;
  let rowsStarted = false;
  let rowCount = 0;
  let recordLine = 1;
  let recordRow = null;

  // Per-record reusable state: spans (flat) and fmeta (flat per field:
  // [spanStart, spanCount, quoted, empty]).
  const spans = [];
  const fmeta = [];

  // The field just read: how it ended, whether it was quoted, whether its
  // value is empty, whether junk content followed its closing quote.
  let fend = END;
  let fquoted = false;
  let fempty = true;
  let fjunk = false;

  function error(code) {
    errParts.push('{"code":"' + code + '","line":' + recordLine + ',"row":' + (recordRow === null ? 'null' : recordRow) + '}');
  }

  // Emit one field's JSON string (from fmeta[fi]) into the output buffer.
  // s0 is a NUMBER index into the flat spans array (3 numbers per span).
  function emitField(fi) {
    const s0 = fmeta[fi * 4];
    const sc = fmeta[fi * 4 + 1];
    wByte(DQ);
    for (let k = 0; k < sc; k++) {
      const a = spans[s0 + k * 3];
      const b = spans[s0 + k * 3 + 1];
      const before = spans[s0 + k * 3 + 2];
      if (before === SP_BEFORE_QUOTE) wEscQuote();
      else if (before === SP_BEFORE_LF) wEscLF();
      if (a !== -1) wSlice(a, b);
    }
    wByte(DQ);
  }

  // The same, as a JS string (only for long_row `extra` values, which are rare).
  function fieldToString(fi) {
    const s0 = fmeta[fi * 4];
    const sc = fmeta[fi * 4 + 1];
    let out = '"';
    for (let k = 0; k < sc; k++) {
      const a = spans[s0 + k * 3];
      const b = spans[s0 + k * 3 + 1];
      const before = spans[s0 + k * 3 + 2];
      if (before === SP_BEFORE_QUOTE) out += '\\"';
      else if (before === SP_BEFORE_LF) out += '\\n';
      if (a !== -1) out += buf.toString('utf8', a, b);
    }
    return out + '"';
  }

  // Emit a whole record (row or header columns) as a JSON array: the first
  // `count` fields, padded with "" up to `padTo` (short rows pad inside).
  function emitRecord(count, padTo) {
    wByte(0x5b); // [
    for (let i = 0; i < count; i++) {
      if (i > 0) wByte(CM);
      emitField(i);
    }
    for (let i = count; i < padTo; i++) {
      if (i > 0) wByte(CM);
      wStr('""');
    }
    wByte(0x5d); // ]
  }

  // Unquoted reader: scans from p, appending spans, until ',', a line break,
  // or the end of the text. Mirrors readUnquotedSlow + the fast unquoted path.
  // `initial` spans are already in `spans` (quoted content / literal quote);
  // `contentSoFar` says whether the value already holds a character.
  // Sets fend, fempty, fjunk (junk content only when called for quote junk).
  function readUnquoted(contentSoFar, forJunk) {
    let segStart = p;
    let hasContent = contentSoFar;
    let junkContent = false;
    while (true) {
      let c = buf.indexOf(CM, p);
      let b = buf.indexOf(BS, p);
      if (c === -1) c = n;
      if (b === -1) b = n;
      if (c < b) {
        if (c > segStart) { spans.push(segStart, c, SP_BEFORE_NONE); hasContent = true; }
        if (forJunk && c > segStart) junkContent = true;
        fend = COMMA;
        p = c + 1;
        break;
      }
      if (b < c) {
        const e = buf[b + 1];
        if (e === CH_N) {
          // LF: the record ends. (A CR just before it was handled at the CR.)
          if (b > segStart) { spans.push(segStart, b, SP_BEFORE_NONE); hasContent = true; }
          if (forJunk && b > segStart) junkContent = true;
          fend = LINE_BREAK;
          p = b + 2;
          line += 1;
          break;
        }
        if (e === CH_R) {
          if (buf[b + 2] === BS && buf[b + 3] === CH_N) {
            // CRLF: the record ends; the CR is part of the break, not content.
            if (b > segStart) { spans.push(segStart, b, SP_BEFORE_NONE); hasContent = true; }
            if (forJunk && b > segStart) junkContent = true;
            fend = LINE_BREAK;
            p = b + 4;
            line += 1;
            break;
          }
          // Lone CR: stray_cr, dropped.
          error('stray_cr');
          if (b > segStart) { spans.push(segStart, b, SP_BEFORE_NONE); hasContent = true; }
          if (forJunk && b > segStart) junkContent = true;
          segStart = b + 2;
          p = b + 2;
          continue;
        }
        // Any other escape is literal content: \" \\ \uXXXX \t \b \f \/ .
        hasContent = true;
        if (forJunk) junkContent = true;
        p = (e === CH_U) ? b + 6 : b + 2;
        continue;
      }
      // Neither ',' nor an escape remains: the field runs to the end.
      if (n > segStart) { spans.push(segStart, n, SP_BEFORE_NONE); hasContent = true; }
      if (forJunk && n > segStart) junkContent = true;
      fend = END;
      p = n;
      break;
    }
    fempty = !hasContent;
    fjunk = junkContent;
  }

  // Quoted reader: p is at the opening \" . Mirrors readQuoted.
  function readQuoted() {
    const open = p;
    const openLine = line;
    const fieldSpans = spans.length; // spans pushed while looking for the close are discarded if it never closes
    let segStart = p + 2;
    let q = p + 2;
    let pending = SP_BEFORE_NONE;
    let close = -1;
    while (true) {
      const b = buf.indexOf(BS, q);
      if (b === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted. Nothing scanned as quoted
        // content counts.
        spans.length = fieldSpans;
        p = open + 2;
        line = openLine;
        error('unterminated_quote');
        spans.push(-1, -1, SP_BEFORE_QUOTE); // the literal opening quote
        fquoted = true;
        readUnquoted(true, false);
        return;
      }
      const e = buf[b + 1];
      if (e === DQ) {
        if (buf[b + 2] === BS && buf[b + 3] === DQ) {
          // Doubled quote: one literal quote; the span ends here.
          if (b > segStart) spans.push(segStart, b, pending);
          else if (pending !== SP_BEFORE_NONE) spans.push(-1, -1, pending);
          pending = SP_BEFORE_QUOTE;
          segStart = b + 4;
          q = b + 4;
          continue;
        }
        close = b;
        break;
      }
      if (e === CH_N) {
        // LF inside quotes: a line break in the value.
        if (b > segStart) spans.push(segStart, b, pending);
        else if (pending !== SP_BEFORE_NONE) spans.push(-1, -1, pending);
        pending = SP_BEFORE_LF;
        segStart = b + 2;
        q = b + 2;
        line += 1;
        continue;
      }
      if (e === CH_R) {
        // CR or CRLF inside quotes: one LF in the value.
        const isCRLF = buf[b + 2] === BS && buf[b + 3] === CH_N;
        if (b > segStart) spans.push(segStart, b, pending);
        else if (pending !== SP_BEFORE_NONE) spans.push(-1, -1, pending);
        pending = SP_BEFORE_LF;
        segStart = isCRLF ? b + 4 : b + 2;
        q = segStart;
        line += 1;
        continue;
      }
      // Any other escape is literal content.
      q = (e === CH_U) ? b + 6 : b + 2;
    }
    // The closing quote's content span.
    if (close > segStart) spans.push(segStart, close, pending);
    else if (pending !== SP_BEFORE_NONE) spans.push(-1, -1, pending);
    fquoted = true;
    p = close + 2;
    if (p >= n) { fend = END; return; }
    if (buf[p] === CM) { fend = COMMA; p += 1; return; }
    if (buf[p] === BS && buf[p + 1] === CH_N) { fend = LINE_BREAK; p += 2; line += 1; return; }
    if (buf[p] === BS && buf[p + 1] === CH_R && buf[p + 2] === BS && buf[p + 3] === CH_N) { fend = LINE_BREAK; p += 4; line += 1; return; }
    // What follows the closing quote is appended as it stands.
    readUnquoted(true, true);
    if (fjunk) error('quote_junk');
  }

  wStr('{"columns":');
  if (!header) {
    wStr('null,"rows":[');
    rowsStarted = true;
  }

  while (true) {
    // Lines with no characters are no records.
    while (p < n) {
      if (buf[p] === BS && buf[p + 1] === CH_N) { p += 2; line += 1; }
      else if (buf[p] === BS && buf[p + 1] === CH_R && buf[p + 2] === BS && buf[p + 3] === CH_N) { p += 4; line += 1; }
      else break;
    }
    if (p >= n) break;

    recordLine = line;
    recordRow = (header && !headerSeen) ? null : rowCount;
    spans.length = 0;
    fmeta.length = 0;
    do {
      const s0 = spans.length;
      if (buf[p] === BS && buf[p + 1] === DQ) {
        readQuoted();
      } else {
        fquoted = false;
        readUnquoted(false, false);
      }
      fmeta.push(s0, (spans.length - s0) / 3, fquoted ? 1 : 0, fempty ? 1 : 0);
    } while (fend === COMMA);

    const fieldCount = fmeta.length / 4;

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fieldCount === 1 && fmeta[3] === 1 && fmeta[2] === 0) continue;

    if (width < 0) width = fieldCount;
    if (header && !headerSeen) {
      headerSeen = true;
      emitRecord(fieldCount, fieldCount);
      wStr(',"rows":[');
      rowsStarted = true;
      continue;
    }
    if (fieldCount < width) {
      errParts.push('{"code":"short_row","line":' + recordLine + ',"row":' + recordRow + ',"fields":' + fieldCount + '}');
    } else if (fieldCount > width) {
      let extra = '[';
      for (let i = width; i < fieldCount; i++) {
        if (i > width) extra += ',';
        extra += fieldToString(i);
      }
      extra += ']';
      errParts.push('{"code":"long_row","line":' + recordLine + ',"row":' + recordRow + ',"extra":' + extra + '}');
    }
    if (rowCount > 0) wByte(CM);
    emitRecord(fieldCount < width ? fieldCount : width, width);
    rowCount++;
  }

  if (header && !headerSeen) {
    wStr('[],"rows":[');
    rowsStarted = true;
  }
  void rowsStarted;
  wStr('],"errors":[');
  wStr(errParts.join(','));
  wStr(']}');
  return ob.subarray(0, op);
}

/** Fast path: answer one case from the raw escaped bytes of its JSON text. WebAssembly when available, the JS transcoder otherwise. Returns a Buffer holding the case's answer JSON. */
export function runBytes(textBuf, header) {
  const w = runBytesWasm(textBuf, header);
  if (w !== null) return w;
  return runBytesJS(textBuf, header);
}

/** Answer one case. A string text takes the contract path; raw escaped JSON bytes take the byte path. */
export function run(input) {
  if (input.text instanceof Uint8Array) return runBytes(input.text, input.header === true);
  return runString(input);
}
