/** Collection (owned models) parsing. Pure: takes the JSON text or object; collection.ts reads files (Node). */

export interface OwnedUnit {
  name: string;
  quantity: number;
  modelsPerUnit: number;
  totalModels: number;
  composition: Record<string, unknown> | null;
  loadout: string | null;
  certainty: string;
  notes: string | null;
}

export interface Collection {
  status: 'loaded' | 'missing' | 'invalid';
  path: string;
  owner: string | null;
  asOf: string | null;
  units: OwnedUnit[];
  rules: Record<string, unknown>;
  notOwned: string[];
  /** Uncertain items: surfaced as warnings, never enforced as hard limits. */
  uncertain: { item: string; notes: string | null }[];
  error?: string;
}

/** Parse a collection document (JSON text or already-parsed object). Invalid input is reported, never fabricated. */
export function parseCollection(input: string | unknown, path = 'inline'): Collection {
  const base: Collection = { status: 'missing', path, owner: null, asOf: null, units: [], rules: {}, notOwned: [], uncertain: [] };
  try {
    const d: any = typeof input === 'string' ? JSON.parse(input) : input;
    if (!d || typeof d !== 'object') throw new Error('collection is not a JSON object');
    const units: OwnedUnit[] = (d.units ?? []).map((u: any) => ({
      name: String(u.name), quantity: Number(u.quantity ?? 1), modelsPerUnit: Number(u.models ?? 1),
      totalModels: Number(u.quantity ?? 1) * Number(u.models ?? 1), composition: u.composition ?? null,
      loadout: u.loadout ?? null, certainty: String(u.certainty ?? 'unknown'), notes: u.notes ?? null,
    }));
    return {
      ...base, status: 'loaded', owner: d.meta?.owner ?? null, asOf: d.meta?.as_of ?? null, units, rules: d.rules ?? {},
      notOwned: (d.not_owned ?? []).map((x: any) => String(x.name ?? x)),
      uncertain: (d.uncertain ?? []).map((x: any) => ({ item: String(x.item ?? x.name ?? x), notes: x.notes ?? null })),
    };
  } catch (e) {
    return { ...base, status: 'invalid', error: String(e) };
  }
}

/**
 * A pasted list used as the unit pool (non-owned faction): every datasheet the list fields, as many copies and models as it fields.
 * Lets the optimizer re-arrange that list (attachments, enhancements, which units to take) without inventing models.
 */
export function collectionFromRoster(r: { name: string | null; faction: string | null; units: { name: string; modelCount: number }[] }, path: string): Collection {
  const by = new Map<string, OwnedUnit>();
  for (const u of r.units) {
    const o = by.get(u.name) ?? { name: u.name, quantity: 0, modelsPerUnit: 0, totalModels: 0, composition: null, loadout: null, certainty: 'from pasted list', notes: 'unit pool = the pasted list' };
    o.quantity += 1; o.modelsPerUnit = Math.max(o.modelsPerUnit, u.modelCount); o.totalModels += u.modelCount; by.set(u.name, o);
  }
  return { status: 'loaded', path, owner: null, asOf: null, units: [...by.values()], rules: {}, notOwned: [], uncertain: [] };
}
