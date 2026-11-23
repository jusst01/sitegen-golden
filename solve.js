// A faster drop-in for makefun-site 1.0.0: run(input) returns the exact output tree its build() returns.
// The vendor code (baselines/makefun-site/vendor/makefun-site/) is the reference; this file follows it stage for
// stage. The wins are local: a single-pass HTML escaper, a run-accumulating inline scanner, hand-written line
// classifiers instead of regexes, and within-case maps for slugify/longDate/word counts/link resolution. Nothing is
// cached across run() calls: every map lives in the one call.

// ---------------------------------------------------------------- text

const AMP = 38, LT = 60, GT = 62, QUOT = 34, APOS = 39;
const ESCAPED = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };
const NEEDS_ESCAPE = new Uint8Array(128);
NEEDS_ESCAPE[AMP] = NEEDS_ESCAPE[LT] = NEEDS_ESCAPE[GT] = NEEDS_ESCAPE[QUOT] = NEEDS_ESCAPE[APOS] = 1;

/** `text` with & < > " and ' escaped, in one pass; a string with none is returned as it is. */
function escapeHtml(text) {
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 && NEEDS_ESCAPE[c] === 1) {
      out += text.slice(last, i) + ESCAPED[c];
      last = i + 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

/** The whitespace `\s` names, as code units (the vendor's regex classes test the same set). */
function isWs(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Whether `s` holds any whitespace (the vendor's `/\s/.test`). */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWs(s.charCodeAt(i))) return true;
  return false;
}

/** Spaces and tabs trimmed from both ends (the vendor's trimLine). */
function trimSpTab(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

const SLUG_MAX = 64;

/** The slug of `text`; `memo` is this run's map from tag name or title to slug. */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX);
  if (out.length > 0 && out.charCodeAt(out.length - 1) === 45) out = out.replace(/-+$/, '');
  if (out === '') out = 'untitled';
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words; `memo` is this run's map from the date string to its words. */
function longDate(date, memo) {
  const hit = memo.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  memo.set(date, out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    // ASCII: only space, tab, LF, VT, FF and CR are whitespace, so one compare covers the common case.
    if (c < 128) {
      if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
      else if (!inWord) { count++; inWord = true; }
    } else if (isWs(c)) inWord = false;
    else if (!inWord) { count++; inWord = true; }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_RE = /^[a-z0-9-]+$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45 ? raw : null;
      if (m === null) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      for (let i = 0; i < 10; i++) {
        const c = raw.charCodeAt(i);
        if (i === 4 || i === 7) { if (c !== 45) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' }; }
        else if (c < 48 || c > 57) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (trimSpTab(inner) === '') return { value: [] };
      const tags = inner.split(',').map((t) => trimSpTab(t));
      for (const t of tags) if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  // A source opens on the line "---" and the front matter runs to the next line that is exactly "---". Scan those
  // lines in place; the body is one slice from after the closing line, never the whole text split.
  if (!(text.length >= 3 && text.charCodeAt(0) === 45 && text.charCodeAt(1) === 45 && text.charCodeAt(2) === 45 && (text.length === 3 || text.charCodeAt(3) === 10))) {
    return { error: 'no front matter' };
  }
  let closeStart = -1;
  let closeEnd = -1;
  let pos = 4;
  const n = text.length;
  let lineNo = 1;
  while (pos <= n) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = n;
    const lineLen = nl - pos;
    if (lineLen === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = nl;
      break;
    }
    lineNo++;
    if (nl === n) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let i = 1;
  pos = 4;
  while (pos < closeStart) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1 || nl > closeStart) nl = closeStart;
    const line = text.slice(pos, nl);
    pos = nl + 1;
    const err = fmLine(data, line, i);
    if (err !== null) return err;
    i++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd === n ? n : closeEnd + 1) };
}

/** One front matter line applied to `data`, or the refusal it gives. */
function fmLine(data, line, i) {
  if (line === '') return null;
  const c0 = line.charCodeAt(0);
  if (c0 === 9 || c0 === 32) {
    let blank = true;
    for (let j = 0; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 9 && c !== 32) { blank = false; break; } }
    if (blank) return null;
  } else if (c0 === 35) return null;
  // key: a-z and _; a colon; then one space and the value, or nothing.
  let k = 0;
  while (k < line.length) { const c = line.charCodeAt(k); if ((c >= 97 && c <= 122) || c === 95) k++; else break; }
  if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
  const key = line.slice(0, k);
  let raw = '';
  if (k + 1 < line.length) {
    if (line.charCodeAt(k + 1) !== 32) return { error: `line ${i + 1} is not "key: value"` };
    raw = line.slice(k + 2);
  }
  let e = raw.length;
  while (e > 0) { const c = raw.charCodeAt(e - 1); if (c === 32 || c === 9) e--; else break; }
  if (e !== raw.length) raw = raw.slice(0, e);
  if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
  if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
  if (raw === '') return { error: `key "${key}" has no value` };
  const v = valueOf(key, raw);
  if ('error' in v) return v;
  data[key] = v.value;
  return null;
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** The characters inline() stops at: backslash, backtick, star, `[`, and the five escapeHtml names. */
const SPECIAL = new Uint8Array(128);
SPECIAL[92] = SPECIAL[96] = SPECIAL[42] = SPECIAL[91] = 1;
SPECIAL[AMP] = SPECIAL[LT] = SPECIAL[GT] = SPECIAL[QUOT] = SPECIAL[APOS] = 1;

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

/** The opening fence's language, or null when `line` is not a fence opening. */
function fenceLang(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}

function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

/** A heading's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const sep = line.charCodeAt(n);
  if (sep !== 32 && sep !== 9) return null;
  let a = n;
  while (a < line.length) { const c = line.charCodeAt(a); if (c !== 32 && c !== 9) break; a++; }
  let b = line.length;
  while (b > a) { const c = line.charCodeAt(b - 1); if (c !== 32 && c !== 9) break; b--; }
  const text = a === b ? '' : line.slice(a, b);
  if (text === '') return null;
  return { depth: n, text };
}

function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  let need;
  if (c0 === 45) need = c0;
  else if (c0 === 42) need = c0;
  else return false;
  if (line.charCodeAt(1) !== need || line.charCodeAt(2) !== need) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function endsParagraph(line) {
  if (isBlankLine(line)) return true;
  if (fenceLang(line) !== null) return true;
  if (headingOf(line) !== null) return true;
  return isHr(line);
}

/** `src`'s block tokens, in order (the vendor's lex). */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // A cheap dispatch on the first character, then the vendor's tests in its order. A line that opens on a letter,
    // a digit other than an ordered marker, or most punctuation is a paragraph: it never needs the block regexes.
    if (line.length !== 0 && c0 !== 32 && c0 !== 9 && c0 !== 96 && c0 !== 35 && c0 !== 45 && c0 !== 42 && c0 !== 62 && !(c0 >= 48 && c0 <= 57)) {
      const body = [trimSpTab(line)];
      i++;
      while (i < L && !endsParagraph(lines[i])) body.push(trimSpTab(lines[i++]));
      tokens.push({ type: 'paragraph', text: body.join('\n') });
      continue;
    }
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < L && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) { tokens.push({ type: 'hr' }); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) { const t = trimSpTab(l); if (t !== '') kept.push(t); }
      tokens.push({ type: 'blockquote', lines: kept });
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      let start = 1;
      if (isOrdered) {
        let k = 0;
        while (k < line.length) { const c = line.charCodeAt(k); if (c >= 48 && c <= 57) k++; else break; }
        start = Number(line.slice(0, k));
      }
      const items = [];
      while (i < L) {
        const cur = lines[i];
        const m = isOrdered ? orderedOf(cur) : bulletOf(cur);
        if (m !== null) { items.push([trimSpTab(m)]); i++; }
        else if (isContinued(cur)) { items[items.length - 1].push(trimSpTab(cur)); i++; }
        else break;
      }
      const out = [];
      for (const parts of items) out.push(parts.join('\n'));
      tokens.push({ type: 'list', ordered: isOrdered, start, items: out });
      continue;
    }
    const body = [trimSpTab(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimSpTab(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** A bullet item's text ("- " or "* "), or null. */
function bulletOf(line) {
  if (line.length < 2) return null;
  const c = line.charCodeAt(0);
  if ((c !== 45 && c !== 42) || line.charCodeAt(1) !== 32) return null;
  return line.slice(2);
}

/** An ordered item's text (digits and ". "), or null. */
function orderedOf(line) {
  let k = 0;
  while (k < line.length) { const c = line.charCodeAt(k); if (c >= 48 && c <= 57) k++; else break; }
  if (k === 0 || k > 9) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return line.slice(k + 2);
}

function isContinued(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  return line.charCodeAt(2) !== 32 && line.charCodeAt(2) !== 9;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const wl = what.length;
  const c0 = what.charCodeAt(0);
  for (let j = from; j <= n - wl; j++) {
    if (s.charCodeAt(j) === 92) {
      if (j + 1 < n) { const d = s.charCodeAt(j + 1); if (d < 128 && ESCAPABLE[d] === 1) { j++; continue; } }
    }
    if (s.charCodeAt(j) === c0) {
      let ok = true;
      for (let q = 1; q < wl; q++) if (s.charCodeAt(j + q) !== what.charCodeAt(q)) { ok = false; break; }
      if (ok) return j;
    }
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n) { const d = s.charCodeAt(j + 1); if (d < 128 && ESCAPABLE[d] === 1) { j++; continue; } }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  let run = 0;
  const n = s.length;
  while (i < n) {
    // Skip the plain run in a tight loop; only the specials below need the branch chain.
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c < 128 && SPECIAL[c] !== 0) break;
      i++;
    }
    if (i >= n) break;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n) {
        const d = s.charCodeAt(i + 1);
        if (d < 128 && ESCAPABLE[d] === 1) {
          out += s.slice(run, i) + escapeHtml(s[i + 1]);
          i += 2;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += s.slice(run, i) + '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += s.slice(run, i) + '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
          run = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += s.slice(run, i) + '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        out += s.slice(run, i) + '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c < 128 && NEEDS_ESCAPE[c] === 1) {
      out += s.slice(run, i) + ESCAPED[c];
      i++;
      run = i;
      continue;
    }
    i++;
  }
  return out + s.slice(run);
}

/** `src` rendered: HTML, table of contents and excerpt. */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const tokens = lex(src);
  for (let ti = 0; ti < tokens.length; ti++) {
    const t = tokens[ti];
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text, env.slugMemo), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        let body = '';
        for (let k = 0; k < t.lines.length; k++) body += escapeHtml(t.lines[k]) + '\n';
        blocks.push(`<pre><code${cls}>${body}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        let items = '';
        for (let k = 0; k < t.items.length; k++) items += `<li>${inline(t.items[k], env)}</li>\n`;
        blocks.push(`${open}\n${items}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += blocks[k] + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isSpTabOnly(s, from, to) {
  for (let i = from; i < to; i++) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) { text += src.slice(i); break; }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isSpTabOnly(src, lineStart, open) && isSpTabOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const toks = tokenize(name, src);
  for (let ti = 0; ti < toks.length; ti++) {
    const tok = toks[ti];
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) out += (k === 0 ? '' : ', ') + textOf(v[k]);
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`. Each var/raw/if/for node is walked directly; a single-name path is looked up without
 *  the dotted loop. */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  const escape = ctx.escape;
  const templates = ctx.templates;
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    const kind = n.kind;
    if (kind === 'text') { out += n.text; continue; }
    if (kind === 'var') {
      const p = n.path;
      let v;
      if (p.length === 1) {
        let s = scope;
        while (s !== null && !Object.hasOwn(s.vars, p[0])) s = s.parent;
        v = s === null ? undefined : s.vars[p[0]];
      } else v = lookup(scope, p);
      out += typeof v === 'string' ? escape(v) : escape(textOf(v));
      continue;
    }
    if (kind === 'raw') {
      const p = n.path;
      let v;
      if (p.length === 1) {
        let s = scope;
        while (s !== null && !Object.hasOwn(s.vars, p[0])) s = s.parent;
        v = s === null ? undefined : s.vars[p[0]];
      } else v = lookup(scope, p);
      out += typeof v === 'string' ? v : textOf(v);
      continue;
    }
    if (kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
      continue;
    }
    if (kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      const len = xs.length;
      if (len === 0) continue;
      if (n.name === 'loop') {
        // `for loop in ...`: the element and the loop record share the name, so build fresh scopes each turn.
        for (let k = 0; k < len; k++) {
          const vars = { loop: xs[k] };
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        continue;
      }
      // One loop scope for the whole loop, its element and loop object mutated per turn: the body renders
      // synchronously, so no earlier turn can still see the old values. Same lookups, no per-iteration allocation.
      const vars = {};
      vars[n.name] = undefined;
      const loop = { index: 0, first: false, last: false, length: len };
      vars.loop = loop;
      const loopScope = { vars, parent: scope };
      for (let k = 0; k < len; k++) {
        vars[n.name] = xs[k];
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === len - 1;
        out += renderNodes(n.body, loopScope, ctx, depth);
      }
      continue;
    }
    // include
    const t = templates.get(n.name);
    if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugMemo = new Map();
  const dateMemo = new Map();
  const linkMemo = new Map();
  const report = [];

  // 2. Templates, parsed in code-unit order of their names; one that does not parse is reported and left out.
  const templates = new Map();
  const names = Object.keys(input.templates).sort(cmp);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; anything else is static.
  const files = input.files.slice().sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 3. Front matter, the generator's own directories, a post's date, its layout, then draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (let d = 0; d < RESERVED.length; d++) {
      const dir = RESERVED[d];
      if (dir !== 'posts' && s.path.startsWith(`${dir}/`)) { own = dir; break; }
    }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 4. Each page's slug made unique in its directory, its output directory and url.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : null);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugMemo), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      slugMemo,
      link(target) {
        const c0 = target.charCodeAt(0);
        // A scheme (letter, then letters/digits/+.- then colon), a leading / or a leading # is kept as written.
        if (c0 === 47 || c0 === 35) return target;
        let sc = 0;
        while (sc < target.length) {
          const c = target.charCodeAt(sc);
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (sc > 0 && ((c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45))) sc++;
          else break;
        }
        if (sc > 0 && sc < target.length && target.charCodeAt(sc) === 58) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const to = bySource.get(path);
          if (to !== undefined) return `${to.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. The posts, newest first and then by slug; each post's newer and older.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. The tags, grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const names2 = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < names2.length; i++) {
      const slug = slugify(names2[i], slugMemo);
      if (!seen.has(slug)) { seen.add(slug); out.push(names2[i]); }
    }
    return out;
  };
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let i = 0; i < names2.length; i++) {
      const name = names2[i];
      const slug = slugify(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names2 = ownTags(s);
    const refs = [];
    for (let k = 0; k < names2.length; k++) {
      const name = names2[k];
      const slug = slugify(name, slugMemo);
      const tag = bySlug.get(slug);
      refs.push(tag !== undefined ? tag : { name, slug, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [];
  for (const t of bySlug.values()) tags.push(t);
  tags.sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // A card, a link record, a tag and a page, as templates read them.
  const cardOf = (s) => {
    let words = s.words;
    if (words === undefined) { words = wordsOf(s.body); s.words = words; }
    const tagsOut = [];
    for (let i = 0; i < s.tagRefs.length; i++) {
      const t = s.tagRefs[i];
      tagsOut.push({ name: t.name, slug: t.slug, url: t.url });
    }
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateMemo),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(words / 200)),
      tags: tagsOut,
    };
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateMemo) });

  // 8. Every page through its layout, the index pages, the tag pages and the statics.
  const output = {};
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = [];
  for (let i = 0; i < tags.length; i++) allTags.push({ name: tags[i].name, slug: tags[i].slug, url: tags[i].url, count: tags[i].posts.length });
  const recent = [];
  const recentEnd = Math.min(posts.length, input.site.recent);
  for (let i = 0; i < recentEnd; i++) recent.push(cards.get(posts[i]));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    // A post's card is built once (posts are the only sources in `cards`); a page builds its own.
    const card = s.post ? cards.get(s) : cardOf(s);
    let toc = s.tocOut;
    if (toc === undefined) {
      toc = [];
      for (let k = 0; k < s.toc.length; k++) { const h = s.toc[k]; toc.push({ level: h.level, id: h.id, html: h.html }); }
      s.tocOut = toc;
    }
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const slice = [];
    for (let i = (k - 1) * per; i < k * per && i < posts.length; i++) slice.push(cards.get(posts[i]));
    const html = render('index', {
      posts: slice,
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const tagPosts = [];
    for (let k = 0; k < t.posts.length; k++) tagPosts.push(cards.get(t.posts[k]));
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tagPosts } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report.
  const lines = report.concat([...broken]);
  lines.sort(cmp);
  let pagesBuilt = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pagesBuilt++;
  lines.push(`built ${pagesBuilt} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
