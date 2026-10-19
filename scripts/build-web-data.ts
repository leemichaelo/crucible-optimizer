/**
 * Build the static data for the web app (web/public/data): catalog shards, refs shard, stratagems, Lee's collection,
 * loadout list and the anonymised opponent lists. Node only (build time). Usage: tsx scripts/build-web-data.ts [--catalog data/catalog.json]
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog } from '../src/types.ts';
import { CatalogIndex } from '../src/catalog/core.ts';
import { splitCatalog, shardFile, armyName, shardsForArmy, RecordingIndex, type ShardManifest, type UnitShard } from '../src/web/shards.ts';
import { opponentsFromTexts, BAND_REFS, TANK_REFS } from '../src/optimize/optimizeCore.ts';
import { attackWeapons, thFeatures } from '../src/optimize/score.ts';
import { buildDefender, type BuildNotes } from '../src/engine/build.ts';
import { NO_MODS } from '../src/engine/types.ts';
import { parseList } from '../src/roster/parse.ts';
import { emptyUnit } from '../src/roster/types.ts';
import { detachmentsFor } from '../src/select/selectionCore.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const catPath = resolve(ROOT, arg('catalog', 'data/catalog.json'));
const out = resolve(ROOT, arg('out', 'web/public/data'));
const src = join(ROOT, 'web', 'data-src');

const cat = JSON.parse(readFileSync(catPath, 'utf8')) as Catalog;
const full = new CatalogIndex(cat);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'units'), { recursive: true });
mkdirSync(join(out, 'opponents'), { recursive: true });
const write = (rel: string, obj: unknown) => { const s = JSON.stringify(obj); writeFileSync(join(out, rel), s); return s.length; };

const { common, unitShards } = splitCatalog(cat);
write('common.json', common);
const unitIndex: ShardManifest['unitShards'] = {};
for (const s of unitShards) unitIndex[s.catalogue] = { file: shardFile(s.catalogue), units: s.units.length, bytes: write(shardFile(s.catalogue), s) };

// opponents (anonymised copies in web/data-src/opponents) + defaults
const oppFiles = readdirSync(join(src, 'opponents')).filter((f) => f.endsWith('.txt')).sort();
const opponents = oppFiles.map((f) => ({ file: f, text: readFileSync(join(src, 'opponents', f), 'utf8') }));
for (const o of opponents) writeFileSync(join(out, 'opponents', o.file), o.text);
writeFileSync(join(out, 'collection.json'), readFileSync(join(src, 'collection-lee-2026-10-15.json')));
writeFileSync(join(out, 'loadout.txt'), readFileSync(join(src, 'loadout-lee-fist-export.txt')));
writeFileSync(join(out, 'stratagems.json'), readFileSync(join(ROOT, 'data', 'stratagems.json')));

// refs shard: every unit the opponent lists resolve to (parse, defender build, attacker weapons) + band/tank reference units
const rec = new RecordingIndex(cat);
const notes: BuildNotes = { heuristics: [], warnings: [] };
const opp = opponentsFromTexts(rec, opponents, notes);
for (const u of opp.units) if (u.attacker) { attackWeapons(rec, u.attacker.scope, u.attacker.units, u.def, notes, { ...NO_MODS, meleeOnly: {}, charged: true }); thFeatures(rec, u.attacker.scope, u.attacker.units.map((x) => ({ u: x, attached: false, pts: 0 }))); }
for (const o of opponents) parseList(o.text, { catalog: rec, sourceFile: o.file });
const refUnits = new Set(rec.seen);
for (const r of BAND_REFS) refUnits.add(cat.units.find((x) => x.name === r.unit && x.catalogue === r.catalogue)!);
for (const n of TANK_REFS) refUnits.add(cat.units.find((x) => x.name === n)!);
// band/tank reference defenders resolve their names through findUnit too
for (const r of BAND_REFS) buildDefender([{ ...emptyUnit(r.unit, null), modelCount: r.models }], rec, [r.catalogue, ...rec.scope(undefined)], notes, 'melee');
for (const n of TANK_REFS) { const e = cat.units.find((x) => x.name === n)!; buildDefender([{ ...emptyUnit(n, null), modelCount: 1 }], rec, rec.scope(e.catalogue.includes('Chaos') ? 'Chaos Space Marines' : 'Astra Militarum'), notes, 'melee'); }
for (const u of rec.seen) refUnits.add(u);
const refs: UnitShard = { catalogue: '(refs)', idx: [], units: [] };
cat.units.forEach((u, i) => { if (refUnits.has(u)) { refs.idx.push(i); refs.units.push(u); } });
write('refs.json', refs);


const armies = cat.catalogues.filter((c) => !c.library).map((c) => {
  const name = armyName(c.name);
  let dets = 0; try { dets = detachmentsFor(full, name).length; } catch { dets = 0; }
  return dets ? { name, catalogue: c.name, shards: shardsForArmy(full, name).map(shardFile) } : null;
}).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => a.name.localeCompare(b.name));

const manifest: ShardManifest = {
  source: cat.source, builtAt: new Date().toISOString(), common: 'common.json', refs: 'refs.json', unitShards: unitIndex, armies,
  defaults: { army: 'Black Templars', collection: 'collection.json', loadout: 'loadout.txt', opponents: oppFiles.map((f) => `opponents/${f}`), stratagems: 'stratagems.json' },
};
write('manifest.json', manifest);
const bt = armies.find((a) => a.name === 'Black Templars')!;
const btBytes = bt.shards.reduce((s, f) => s + Object.values(unitIndex).find((x) => x.file === f)!.bytes, 0);
process.stdout.write(JSON.stringify({ out, armies: armies.length, unitShards: unitShards.length, refsUnits: refs.units.length, opponents: oppFiles.length, blackTemplarsShards: bt.shards, blackTemplarsUnitBytes: btBytes }) + '\n');
