/**
 * In-memory cell cache (pure: no file access, no node:crypto). Keys are a deterministic 128-bit hash of the
 * JSON of the key parts. The Node CellCache (cache.ts) extends this with sha256 keys and a file under .cache/.
 */
import type { Cell } from './score.ts';

/** Deterministic, synchronous 128-bit string hash (four 32-bit FNV/murmur-style lanes). Not cryptographic; collision risk is negligible at cache sizes. */
export function hash128(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9, h3 = 0x85ebca6b, h4 = 0xc2b2ae35;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h3 = Math.imul(h3 ^ c, 0x27d4eb2f) + (h1 >>> 7);
    h4 = Math.imul(h4 ^ c, 0x165667b1) ^ (h2 >>> 13);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ h4; h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35) ^ h3;
  h3 = Math.imul(h3 ^ (h3 >>> 16), 0x27d4eb2f) ^ h1; h4 = Math.imul(h4 ^ (h4 >>> 15), 0x165667b1) ^ h2;
  return [h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** What the optimizer/assess need from a cell cache. */
export interface CellStore {
  key(parts: unknown): string;
  get(k: string): Cell | undefined;
  set(k: string, v: Cell): void;
  save(): void;
  stats(): Record<string, unknown>;
}

export class MemoryCellCache implements CellStore {
  protected map = new Map<string, Cell>();
  hits = 0; misses = 0; dirty = false;
  constructor(readonly enabled = true, initial?: Record<string, Cell>) { if (initial) for (const [k, v] of Object.entries(initial)) this.map.set(k, v); }
  key(parts: unknown): string { return hash128(JSON.stringify(parts)); }
  get(k: string): Cell | undefined { const v = this.enabled ? this.map.get(k) : undefined; if (v) this.hits++; else this.misses++; return v; }
  set(k: string, v: Cell) { if (!this.enabled) return; this.map.set(k, v); this.dirty = true; }
  save() { this.dirty = false; }
  /** Plain object snapshot (e.g. for IndexedDB persistence in the browser). */
  toJSON(): Record<string, Cell> { return Object.fromEntries(this.map); }
  get size() { return this.map.size; }
  stats(): Record<string, unknown> { return { file: null, enabled: this.enabled, entries: this.map.size, hits: this.hits, misses: this.misses, invalidatedFiles: [] }; }
}
