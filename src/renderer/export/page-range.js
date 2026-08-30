// Parses "1-3, 5, 7-9" into a sorted, deduped page-number array clamped to
// [1, numPages]. Returns null for an empty/entirely-invalid string so the
// caller can tell "nothing usable was entered" from "page 1 only".
export function parsePageRange(input, numPages) {
  if (!input || !input.trim()) return null;
  const set = new Set();
  for (const part of input.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(p);
    if (range) {
      let a = parseInt(range[1], 10);
      let b = parseInt(range[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) if (n >= 1 && n <= numPages) set.add(n);
    } else if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10);
      if (n >= 1 && n <= numPages) set.add(n);
    }
  }
  const out = Array.from(set).sort((a, b) => a - b);
  return out.length ? out : null;
}
