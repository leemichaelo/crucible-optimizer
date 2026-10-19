/**
 * Catalog shards for the static web build (pure: no file access). data/catalog.json (11 MB) is split into
 *  - common.json: source, catalogue list, every enhancement and detachment (the roster parser needs all enhancement names),
 *  - units/<catalogue>.json: the units of one catalogue,
 *  - refs.json: the few units from other catalogues that the fixed opponent lists and the band/tank reference targets use.
 * An army loads common + the unit shards of its scope (its catalogue and imports, e.g. Space Marines and libraries) + refs.
 * Every unit keeps its original catalog index, so merged shards preserve lookup order exactly.
 */
import type { Catalog, UnitEntry } from '../types.ts';
import { CatalogIndex } from '../catalog/core.ts';

export interface UnitShard { catalogue: string; idx: number[]; units: UnitEntry[]; }
export interface CommonShard { source: Catalog['source']; catalogues: Catalog['catalogues']; enhancements: Catalog['enhancements']; detachments: Catalog['detachments']; stats: Catalog['stats']; }
export interface ShardManifest {
  source: Catalog['source'];
  builtAt: string;
  common: string;
  refs: string;
  /** catalogue name -> shard file (relative to the data dir). */
  unitShards: Record<string, { file: string; units: number; bytes: number }>;
  /** Selectable armies (non-library catalogues with at least one detachment), with the unit shards they need. */
  armies: { name: string; catalogue: string; shards: string[] }[];
  defaults: { army: string; collection: string; loadout: string; opponents: string[]; stratagems: string };
}

export const shardFile = (catalogue: string) => `units/${catalogue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;

/** Short army name from a catalogue name ("Imperium - Adeptus Astartes - Black Templars" -> "Black Templars"). */
export const armyName = (catalogue: string) => catalogue.split(' - ').pop()!.trim();

export function splitCatalog(cat: Catalog): { common: CommonShard; unitShards: UnitShard[] } {
  const by = new Map<string, UnitShard>();
  cat.units.forEach((u, i) => { const s = by.get(u.catalogue) ?? by.set(u.catalogue, { catalogue: u.catalogue, idx: [], units: [] }).get(u.catalogue)!; s.idx.push(i); s.units.push(u); });
  return { common: { source: cat.source, catalogues: cat.catalogues, enhancements: cat.enhancements, detachments: cat.detachments, stats: cat.stats }, unitShards: [...by.values()] };
}

/** Rebuild a Catalog from the common shard and any number of unit shards (duplicates by index are dropped; original order kept). */
export function mergeShards(common: CommonShard, shards: UnitShard[]): Catalog {
  const seen = new Map<number, UnitEntry>();
  for (const s of shards) s.idx.forEach((i, k) => { if (!seen.has(i)) seen.set(i, s.units[k]!); });
  const units = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => u);
  return { source: common.source, catalogues: common.catalogues, enhancements: common.enhancements, detachments: common.detachments, stats: common.stats, units };
}

/** Unit shards an army needs: every catalogue in its scope (own + imports, transitively, + Unaligned Forces). */
export function shardsForArmy(index: CatalogIndex, army: string): string[] {
  return index.scope(army).filter((c) => index.cat.units.some((u) => u.catalogue === c));
}

/** CatalogIndex that records every unit it returns (used at build time to cut the refs shard). */
export class RecordingIndex extends CatalogIndex {
  readonly seen = new Set<UnitEntry>();
  override findUnit(name: string, scope: string[] = []): UnitEntry | undefined { const u = super.findUnit(name, scope); if (u) this.seen.add(u); return u; }
}
