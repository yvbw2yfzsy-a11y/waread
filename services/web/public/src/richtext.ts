// WhatsApp text formatting: *bold*, _italic_, ~strikethrough~, `code` and ```blocks```. A pure parser (no DOM) so it can
// be tested in Node; util.ts turns the tree into DOM nodes with textContent only, never innerHTML.
//
// Rules (as WhatsApp applies them): an opening mark must stand at the start or after whitespace/opening punctuation (so
// snake_case_names and 2*3*4 stay plain); the text inside must not start or end with whitespace; a closing mark must be
// followed by the end, whitespace or punctuation; marks do not span lines. Marks may nest, up to three levels.

export type RichNode =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 's'; c: RichNode[] }
  | { t: 'code'; v: string }
  | { t: 'pre'; v: string };

const MARK: Record<string, 'b' | 'i' | 's'> = { '*': 'b', _: 'i', '~': 's' };
const OPEN_BEFORE = /[\s([{"'“„>]/;
const CLOSE_AFTER = /[\s.,;:!?)\]}"'”“<]/;
const MAX_DEPTH = 3;

function findClose(text: string, open: number, ch: string): number {
  for (let k = open + 2; k < text.length; k++) {
    const c = text[k];
    if (c === '\n') return -1;
    if (c !== ch) continue;
    const before = text[k - 1] ?? '';
    if (/\s/.test(before)) continue;
    const after = text[k + 1];
    if (after === undefined || CLOSE_AFTER.test(after) || after in MARK) return k;
  }
  return -1;
}

export function parseRich(text: string, depth = 0): RichNode[] {
  const out: RichNode[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') { out.push({ t: 'text', v: buf }); buf = ''; }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '`' && text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      if (end > i + 3) {
        flush();
        out.push({ t: 'pre', v: text.slice(i + 3, end).replace(/^\n|\n$/g, '') });
        i = end + 3;
        continue;
      }
    } else if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes('\n')) {
        flush();
        out.push({ t: 'code', v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch in MARK && depth < MAX_DEPTH) {
      const prev = i === 0 ? '' : (text[i - 1] as string);
      const next = text[i + 1];
      const openOk = i === 0 || OPEN_BEFORE.test(prev) || prev in MARK;
      if (openOk && next !== undefined && !/\s/.test(next) && next !== ch) {
        const close = findClose(text, i, ch);
        if (close > i + 1) {
          flush();
          out.push({ t: MARK[ch] as 'b' | 'i' | 's', c: parseRich(text.slice(i + 1, close), depth + 1) });
          i = close + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}
