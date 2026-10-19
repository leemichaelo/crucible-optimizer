/**
 * Build-time check: the optimizer gives identical results on the full catalog and on the merged web shards
 * (common + army unit shards + refs), using the same data the web app ships. Usage: tsx scripts/check-shard-equivalence.ts [detachment] [disposition] [minDedicated]
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog } from '../src/types.ts';
import { CatalogIndex } from '../src/catalog/core.ts';
import { mergeShards, type CommonShard, type ShardManifest, type UnitShard } from '../src/web/shards.ts';
import { runOptimizeCore, bestText } from '../src/select/runCore.ts';
import { parseCollection } from '../src/validate/collectionCore.ts';
import { MemoryCellCache } from '../src/optimize/cellCache.ts';
import { WEB_BASE } from '../src/web/options.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const D = join(ROOT, 'web', 'public', 'data');
const j = <T>(f: string) => JSON.parse(readFileSync(join(D, f), 'utf8')) as T;
const man = j<ShardManifest>('manifest.json');
const army = man.armies.find((a) => a.name === 'Black Templars')!;
const shardCat = mergeShards(j<CommonShard>('common.json'), [...army.shards.map((f) => j<UnitShard>(f)), j<UnitShard>('refs.json')]);
const fullCat = JSON.parse(readFileSync(join(ROOT, 'data', 'catalog.json'), 'utf8')) as Catalog;
const data = { collection: parseCollection(readFileSync(join(D, 'collection.json'), 'utf8'), 'collection.json'), opponents: man.defaults.opponents.map((f) => ({ file: f.split('/').pop()!, text: readFileSync(join(D, f), 'utf8') })),
  loadout: { file: 'loadout.txt', text: readFileSync(join(D, 'loadout.txt'), 'utf8') }, stratagems: j<never>('stratagems.json') };
const det = process.argv[2] ?? 'Vow-Sworn Crusaders'; const disp = process.argv[3] ?? 'Purge the Foe'; const ded = Number(process.argv[4] ?? 2);
const run = (c: Catalog) => { const t = Date.now(); const r = runOptimizeCore(new CatalogIndex(c), { army: 'Black Templars', detachment: det.split('+'), disposition: disp, base: { ...WEB_BASE, minDedicatedTankKillers: ded } }, data, { cache: new MemoryCellCache() }); return { r, ms: Date.now() - t }; };
const a = run(fullCat); const b = run(shardCat);
const strip = (x: unknown) => JSON.stringify(x, (k, v) => (k === 'runtimeMs' || k === 'cache' ? undefined : v));
const same = strip(a.r.per.map((p) => p.res)) === strip(b.r.per.map((p) => p.res)) && bestText(a.r) === bestText(b.r);
process.stdout.write(JSON.stringify({ det, disp, ded, identical: same, fullMs: a.ms, shardMs: b.ms, units: { full: fullCat.units.length, shards: shardCat.units.length } }) + '\n' + bestText(b.r).split('\n').slice(-6).join('\n') + '\n');
if (!same) process.exitCode = 1;
