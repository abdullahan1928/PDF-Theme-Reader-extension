// Text search helpers. Pure functions, no DOM access.
//
// A page's text is a list of items ({ str, eol }). We fold them into one
// searchable string (lower-cased, accents and ligatures flattened, whitespace
// collapsed) while remembering which item and which character each folded
// character came from. That lets a match that spans several text-layer spans
// be mapped back onto exactly the characters it covers.

const COMBINING = /[\u0300-\u036f]/g;
const SPACE = /\s/;

function foldChar(ch, matchCase) {
  let out = ch.normalize("NFKD").replace(COMBINING, "");
  if (!matchCase) out = out.toLowerCase();
  return out;
}

export function normalizeQuery(query, matchCase = false) {
  let out = "";
  for (const ch of String(query || "")) {
    for (const f of foldChar(ch, matchCase)) {
      if (SPACE.test(f)) {
        if (out && out[out.length - 1] !== " ") out += " ";
      } else {
        out += f;
      }
    }
  }
  return out.trimEnd();
}

export function buildIndex(items, matchCase = false) {
  const chars = [];
  const itemOf = [];
  const offOf = [];

  const push = (c, item, off) => {
    chars.push(c);
    itemOf.push(item);
    offOf.push(off);
  };

  for (let i = 0; i < items.length; i++) {
    const str = items[i].str;
    let off = 0;
    for (const ch of str) {
      for (const f of foldChar(ch, matchCase)) {
        if (SPACE.test(f)) {
          if (chars.length && chars[chars.length - 1] !== " ") push(" ", i, off);
        } else {
          push(f, i, off);
        }
      }
      off += ch.length;
    }
    if (items[i].eol && chars.length && chars[chars.length - 1] !== " ") {
      push(" ", i, str.length);
    }
  }

  return { text: chars.join(""), itemOf, offOf, items };
}

// Non-overlapping matches, as [start, end) offsets into index.text.
export function findAll(index, query) {
  const out = [];
  if (!query) return out;
  let from = 0;
  for (;;) {
    const at = index.text.indexOf(query, from);
    if (at === -1) break;
    out.push({ start: at, end: at + query.length });
    from = at + query.length;
  }
  return out;
}

// Map one match onto per-item character ranges: Map(itemIndex -> [[from, to), ...]).
export function rangesFor(index, match) {
  const out = new Map();
  let last = null;
  for (let k = match.start; k < match.end; k++) {
    const item = index.itemOf[k];
    const off = index.offOf[k];
    const str = index.items[item].str;
    if (off >= str.length) continue; // synthetic end-of-line space
    const len = String.fromCodePoint(str.codePointAt(off)).length;
    if (last && last.item === item && last.to === off) {
      last.to = off + len;
      last.range[1] = last.to;
    } else {
      const range = [off, off + len];
      if (!out.has(item)) out.set(item, []);
      out.get(item).push(range);
      last = { item, to: off + len, range };
    }
  }
  return out;
}
