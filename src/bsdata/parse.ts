/** Pure helpers that turn BSData characteristic strings into typed values. */
import type { BaseSize, WeaponAbility } from '../types.ts';

export function parseSkill(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d)\+$/);
  return m ? Number(m[1]) : null;
}

export function parseIntOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const m = s.trim().match(/^-?\d+/);
  return m ? Number(m[0]) : null;
}

export function parseAP(s: string | undefined): number {
  const n = parseIntOrNull(s);
  return n ?? 0;
}

export function parseBase(raw: string | undefined): BaseSize {
  const r = (raw ?? '').trim();
  const oval = r.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*mm$/i);
  if (oval) return { raw: r, diameterMm: null, ovalMm: [Number(oval[1]), Number(oval[2])], estimate: false, label: 'EXACT' };
  const round = r.match(/^(\d+(?:\.\d+)?)\s*mm$/i);
  if (round) return { raw: r, diameterMm: Number(round[1]), ovalMm: null, estimate: false, label: 'EXACT' };
  // "Hull" and anything unparseable: no number in BSData, footprint is an estimate.
  return { raw: r, diameterMm: null, ovalMm: null, estimate: true, label: 'ESTIMATE' };
}

/** Parse a BSData weapon Keywords string like "Anti-Vehicle 4+, Devastating Wounds, Sustained Hits 1". */
export function parseWeaponKeywords(raw: string | undefined): WeaponAbility[] {
  const out: WeaponAbility[] = [];
  const s = (raw ?? '').trim();
  if (!s || s === '-') return out;
  for (const partRaw of s.split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    let p = part.toLowerCase().replace(/twin[ -]linked/, 'twin-linked');
    let condition: string | undefined;
    const ci = p.indexOf(':');
    if (ci >= 0) { condition = p.slice(ci + 1).trim(); p = p.slice(0, ci).trim(); }
    const a: WeaponAbility = { kind: '', raw: part };
    if (condition) a.condition = condition;
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^anti-(.+?)\s+(\d)\+$/))) { a.kind = 'anti'; a.keyword = m[1]!.trim(); a.n = Number(m[2]); }
    else if ((m = p.match(/^sustained hits\s+(\d+)$/))) { a.kind = 'sustained-hits'; a.n = Number(m[1]); }
    else if ((m = p.match(/^sustained hits\s+(d\d+(?:\+\d+)?)$/))) { a.kind = 'sustained-hits'; a.dice = m[1]!.toUpperCase(); }
    else if ((m = p.match(/^blast(?:\s+(\d+))?$/))) { a.kind = 'blast'; a.n = m[1] ? Number(m[1]) : 1; }
    else if ((m = p.match(/^melta\s+(\d+)$/))) { a.kind = 'melta'; a.n = Number(m[1]); }
    else if ((m = p.match(/^rapid fire\s+(\d+)$/))) { a.kind = 'rapid-fire'; a.n = Number(m[1]); }
    else if ((m = p.match(/^rapid fire\s+(d\d+(?:\+\d+)?)$/))) { a.kind = 'rapid-fire'; a.dice = m[1]!.toUpperCase(); }
    else if ((m = p.match(/^cleave\s+(\d+)$/))) { a.kind = 'cleave'; a.n = Number(m[1]); }
    else a.kind = p.replace(/\s+/g, '-');
    out.push(a);
  }
  return out;
}

/** Name normaliser used for all lookups (same idea as CRUCIBLE catalog.ts norm). */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
