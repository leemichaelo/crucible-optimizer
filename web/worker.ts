/**
 * Web Worker: loads the catalog shards for one army and runs the optimizer entirely in the browser.
 * Messages in:  {type:'init'} | {type:'loadArmy', army} | {type:'parse', text, seq} | {type:'run', req}
 * Messages out: {type:'ready', manifest} | {type:'army', army, detachments} | {type:'progress', p, elapsedMs} | {type:'result', ...} | {type:'error', message}
 */
import { CatalogIndex } from '../src/catalog/core.ts';
import { mergeShards, type CommonShard, type ShardManifest, type UnitShard } from '../src/web/shards.ts';
import { detachmentsFor } from '../src/select/selectionCore.ts';
import { runOptimizeCore, bestText, infeasibilityText, type RunData, type RunProgress } from '../src/select/runCore.ts';
import { parseCollection } from '../src/validate/collectionCore.ts';
import { MemoryCellCache } from '../src/optimize/cellCache.ts';
import type { Cell } from '../src/optimize/score.ts';
import type { StratagemFile } from '../src/rules/stratagemsCore.ts';
import { WEB_BASE } from '../src/web/options.ts';
import { autofillFromText } from '../src/web/autofill.ts';
import type { RunRequest } from './types.ts';


const ctx = self as unknown as DedicatedWorkerGlobalScope;
let DATA = '';
const json = async <T>(f: string): Promise<T> => { const r = await fetch(DATA + f); if (!r.ok) throw new Error(`fetch ${f}: HTTP ${r.status}`); return (await r.json()) as T; };
const text = async (f: string): Promise<string> => { const r = await fetch(DATA + f); if (!r.ok) throw new Error(`fetch ${f}: HTTP ${r.status}`); return r.text(); };

let manifest: ShardManifest | null = null;
let common: Promise<CommonShard> | null = null;
let refs: Promise<UnitShard> | null = null;
const shardCache = new Map<string, Promise<UnitShard>>();
let shared: Promise<RunData> | null = null;
let current: { army: string; cat: CatalogIndex } | null = null;
let cache: MemoryCellCache | null = null;
let commonCat: CatalogIndex | null = null;

// ---- IndexedDB persistence of exact-engine cells (keyed by BSData commit + data build), so a repeat run is fast ----
const IDB = 'crucible-optimizer', STORE = 'cells';
function idb(): Promise<IDBDatabase> { return new Promise((res, rej) => { const q = indexedDB.open(IDB, 1); q.onupgradeneeded = () => q.result.createObjectStore(STORE); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbGet(k: string): Promise<Record<string, Cell> | undefined> { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => res(q.result as Record<string, Cell> | undefined); q.onerror = () => res(undefined); }); } catch { return undefined; } }
async function idbPut(k: string, v: unknown): Promise<void> { try { const db = await idb(); await new Promise<void>((res) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).clear(); t.objectStore(STORE).put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); } catch { /* private mode etc.: cache stays in memory */ } }
const cacheKey = () => `cells-${manifest!.source.commit.slice(0, 12)}-${manifest!.builtAt}`;

async function loadArmy(army: string): Promise<CatalogIndex> {
  if (current?.army === army) return current.cat;
  const a = manifest!.armies.find((x) => x.name === army);
  if (!a) throw new Error(`army "${army}" is not in the web data (choose one of: ${manifest!.armies.map((x) => x.name).join(', ')})`);
  common ??= json<CommonShard>(manifest!.common);
  refs ??= json<UnitShard>(manifest!.refs);
  const shards = await Promise.all(a.shards.map((f) => shardCache.get(f) ?? (shardCache.set(f, json<UnitShard>(f)), shardCache.get(f)!)));
  const cat = new CatalogIndex(mergeShards(await common, [...shards, await refs]));
  current = { army, cat };
  return cat;
}

function loadShared(): Promise<RunData> {
  return shared ??= (async () => {
    const d = manifest!.defaults;
    const [col, loadout, strats, opps] = await Promise.all([text(d.collection), text(d.loadout), json<StratagemFile>(d.stratagems), Promise.all(d.opponents.map(async (f) => ({ file: f.split('/').pop()!, text: await text(f) })))]);
    return { collection: parseCollection(col, "Lee's collection (2026-10-15)"), loadout: { file: "Lee's list export (wargear source)", text: loadout }, stratagems: strats, opponents: opps };
  })();
}

ctx.onmessage = async (ev: MessageEvent) => {
  const m = ev.data as { type: string; army?: string; req?: RunRequest; dataUrl?: string; text?: string; seq?: number };
  try {
    if (m.type === 'init') {
      DATA = m.dataUrl!;
      manifest = await json<ShardManifest>('manifest.json');
      ctx.postMessage({ type: 'ready', manifest: { source: manifest.source, builtAt: manifest.builtAt, armies: manifest.armies.map((a) => a.name), defaultArmy: manifest.defaults.army } });
    } else if (m.type === 'loadArmy') {
      const t = performance.now();
      const cat = await loadArmy(m.army!);
      ctx.postMessage({ type: 'army', army: m.army, loadMs: Math.round(performance.now() - t), units: cat.cat.units.length,
        detachments: detachmentsFor(cat, m.army!).map((d) => ({ name: d.name, dispositions: d.dispositions, dp: d.detachmentPoints })) });
    } else if (m.type === 'parse') {
      // header-level parse needs only the common shard (catalogues, detachments, enhancements); units come from the current army if loaded
      common ??= json<CommonShard>(manifest!.common);
      const cat = current?.cat ?? (commonCat ??= new CatalogIndex(mergeShards(await common, [])));
      try { ctx.postMessage({ type: 'parsed', seq: m.seq, fill: autofillFromText(cat, m.text ?? '', manifest!.armies.map((a) => a.name)) }); }
      catch (e) { ctx.postMessage({ type: 'parsed', seq: m.seq, fill: { kind: 'list', notices: [`Could not parse the paste: ${(e as Error).message}`], detachments: [] } }); }
    } else if (m.type === 'run') {
      const r = m.req!;
      const t0 = performance.now();
      const [cat, data] = await Promise.all([loadArmy(r.army), loadShared()]);
      if (!cache) cache = new MemoryCellCache(true, await idbGet(cacheKey()));
      const cachedBefore = cache.size;
      const det = r.detachment === 'all' ? 'all' as const : [...new Set([r.detachment, r.detachment2, r.detachment3].map((x) => x.trim()).filter(Boolean))];
      let last = 0;
      const run = runOptimizeCore(cat, {
        army: r.army, detachment: det, disposition: r.disposition,
        input: r.input.trim() ? { text: r.input, name: 'pasted text' } : null,
        base: { ...WEB_BASE, minDedicatedTankKillers: r.minDedicatedTankKillers, minBandUnits: r.minBandUnits, beamWidth: r.beamWidth, points: r.points, minPoints: r.points - 50, warlord: r.warlord.trim() || null },
      }, data, { cache, onProgress: (p: RunProgress) => { const now = performance.now(); if (now - last > 150 || p.phase === 'done') { last = now; ctx.postMessage({ type: 'progress', p, elapsedMs: Math.round(now - t0) }); } } });
      const elapsedMs = Math.round(performance.now() - t0);
      const best = bestText(run);
      const w = run.winner;
      const top = w?.res.results[0] as { score: number; points: number; enhancements: string[]; dedicatedTankKillers: string[]; tankKillers: string[]; validation: { warnings: string[] } } | undefined;
      ctx.postMessage({
        type: 'result', elapsedMs, bestTxt: best, feasible: !!w?.best,
        summary: {
          army: run.army, disposition: run.disposition, inputNote: run.inputNote, skipped: run.skipped, ranking: run.ranking,
          detachments: w?.detachments ?? [], score: top?.score ?? null, points: top?.points ?? null, enhancements: top?.enhancements ?? [],
          dedicatedTankKillers: top?.dedicatedTankKillers ?? [], tankKillers: top?.tankKillers ?? [],
          gaps: w?.gaps ?? [], infeasible: run.per.filter((p) => !p.best).map((p) => infeasibilityText(p.detachments, p.res.infeasibility as never)).join(''),
          cache: { entriesBefore: cachedBefore, entriesAfter: cache.size },
        },
      });
      if (cache.size !== cachedBefore) void idbPut(cacheKey(), cache.toJSON());
    }
  } catch (e) {
    ctx.postMessage({ type: 'error', message: (e as Error).message ?? String(e) });
  }
};
