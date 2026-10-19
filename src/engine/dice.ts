/** Exact discrete distributions for dice expressions. */

/** Probability vector indexed by value. */
export type Dist = number[];

export function point(v: number): Dist { const d = new Array(v + 1).fill(0); d[v] = 1; return d; }

export function convolve(a: Dist, b: Dist): Dist {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) { if (!a[i]) continue; for (let j = 0; j < b.length; j++) if (b[j]) out[i + j] += a[i]! * b[j]!; }
  return out;
}

export function shift(a: Dist, k: number): Dist {
  if (k >= 0) return [...new Array(k).fill(0), ...a];
  // negative shift: floor at 0 (e.g. damage reduction, min handled by caller)
  const out = new Array(Math.max(1, a.length + k)).fill(0);
  a.forEach((p, v) => { out[Math.max(0, v + k)] += p; });
  return out;
}

export function power(a: Dist, n: number): Dist {
  let r: Dist = [1];
  for (let i = 0; i < n; i++) r = convolve(r, a);
  return r;
}

export function mean(a: Dist): number { return a.reduce((s, p, v) => s + p * v, 0); }

/** Parse "3", "D6", "D3", "2D6", "D6+1", "D3+3", "2D6+2". */
export function diceDist(expr: string | number): Dist {
  if (typeof expr === 'number') return point(expr);
  const s = String(expr).trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) return point(Number(s));
  const m = s.match(/^(\d*)D(3|6)([+-]\d+)?$/);
  if (!m) throw new Error(`unsupported dice expression "${expr}"`);
  const n = m[1] ? Number(m[1]) : 1;
  const one: Dist = m[2] === '6' ? [0, 1, 1, 1, 1, 1, 1].map((x) => x / 6) : [0, 2, 2, 2].map((x) => x / 6);
  return shift(power(one, n), m[3] ? Number(m[3]) : 0);
}

export function isDiceExpr(s: string): boolean {
  try { diceDist(s); return true; } catch { return false; }
}
