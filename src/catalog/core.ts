/** Catalog indexing and faction-scoped lookup. Pure: no file access (see catalog.ts for the Node loader). */
import type { Catalog, Enhancement, PointsTier, UnitEntry } from '../types.ts';
import { norm } from '../bsdata/parse.ts';

/** Wraps a Catalog with indexes for faction-scoped lookup. */
export class CatalogIndex {
  private byNorm = new Map<string, UnitEntry[]>();
  private enhByNorm = new Map<string, Enhancement[]>();
  constructor(public cat: Catalog) {
    for (const u of cat.units) {
      const k = norm(u.name);
      (this.byNorm.get(k) ?? this.byNorm.set(k, []).get(k)!).push(u);
    }
    for (const e of cat.enhancements) {
      const k = norm(e.name);
      (this.enhByNorm.get(k) ?? this.enhByNorm.set(k, []).get(k)!).push(e);
    }
  }

  /** Catalogue names reachable from a faction name (its catalogue plus imported catalogues, transitively). */
  scope(faction: string | undefined): string[] {
    if (!faction) return [];
    const f = norm(faction);
    const start = this.cat.catalogues.filter((c) => {
      const n = norm(c.name);
      return n === f || n.endsWith(' ' + f) || n.split(' ').slice(-f.split(' ').length).join(' ') === f;
    });
    const out = new Set<string>();
    const stack = start.map((c) => c.name);
    while (stack.length) {
      const n = stack.pop()!;
      if (out.has(n)) continue;
      out.add(n);
      const c = this.cat.catalogues.find((x) => x.name === n);
      for (const i of c?.imports ?? []) stack.push(i);
    }
    // Always allow the game system shared catalogue and unaligned forces as a fallback.
    for (const c of this.cat.catalogues) if (/unaligned/i.test(c.name)) out.add(c.name);
    return [...out];
  }

  findUnit(name: string, scope: string[] = []): UnitEntry | undefined {
    let cands = this.byNorm.get(norm(name)) ?? this.byNorm.get(norm(name).replace(/s$/, '')) ?? this.fuzzy(name);
    // 40k App names Terminator-armour characters "Terminator <X>"; BSData names the datasheet "<X> in Terminator Armour".
    const ta = norm(name).match(/^terminator (.+)$/);
    if (!cands.length && ta) cands = this.byNorm.get(norm(`${ta[1]} in Terminator Armour`)) ?? [];
    if (!cands.length) return undefined;
    if (scope.length) {
      // prefer the first scope catalogue (the faction itself) over imports
      for (const s of scope) {
        const hit = cands.find((u) => u.catalogue === s);
        if (hit) return hit;
      }
    }
    return cands[0];
  }

  private fuzzy(name: string): UnitEntry[] {
    const n = norm(name).replace(/\bsquad\b/g, '').replace(/\s+/g, ' ').trim();
    const out: UnitEntry[] = [];
    for (const [k, v] of this.byNorm) if (k.replace(/\bsquad\b/g, '').replace(/\s+/g, ' ').trim() === n) out.push(...v);
    return out;
  }

  findEnhancement(name: string, scope: string[] = []): Enhancement | undefined {
    const c = this.enhByNorm.get(norm(name)) ?? this.enhByNorm.get(norm(name.replace(/\s*\((upgrade|aura)\)\s*/gi, ' '))) ?? [];
    return c.find((e) => scope.includes(e.catalogue)) ?? c[0];
  }
}

/** Points for a unit at a given model count, from BSData root cost + size tiers. */
export function pointsFor(u: UnitEntry, models: number, childCount: (name: string) => number = () => 0): number | null {
  if (u.pts === null) return null;
  let p = u.pts;
  const ok = (t: PointsTier) => {
    if (models < t.minModels || (t.maxModels !== undefined && models > t.maxModels)) return false;
    if (!t.requires) return true;
    const n = childCount(t.requires.child); const v = t.requires.value;
    switch (t.requires.type) { case 'equalTo': return n === v; case 'atLeast': return n >= v; case 'greaterThan': return n > v; case 'atMost': return n <= v; case 'lessThan': return n < v; default: return false; }
  };
  // unconditional tiers first, then tiers with requirements (more specific) override
  for (const t of [...u.pointsTiers.filter((x) => !x.requires), ...u.pointsTiers.filter((x) => x.requires)]) if (ok(t)) p = t.pts;
  return p;
}
