/** Shared optimize entry (pure): three selections + data in, ranked lists + export text out. Used by the Node CLI/page (run.ts) and the browser worker. */
import type { CatalogIndex } from '../catalog/core.ts';
import { parseCollection, collectionFromRoster, type Collection } from '../validate/collectionCore.ts';
import { parseList } from '../roster/parse.ts';
import { norm } from '../bsdata/parse.ts';
import { optimizeCore, type OptimizeOptions, type OptimizeProgress, type SourceText } from '../optimize/optimizeCore.ts';
import type { CellStore } from '../optimize/cellCache.ts';
import type { StratagemFile } from '../rules/stratagemsCore.ts';
import { toGwAppText } from '../export/gwapp.ts';
import { chapterLocked, detachmentsFor, missionKey, parseDisposition, resolveSelection, dispositionMedians } from './selectionCore.ts';

export interface RunData {
  /** Default collection (owned-model caps), used unless a pasted collection replaces it. */
  collection: Collection;
  opponents: SourceText[];
  /** Default loadout list (unit wargear), used unless a pasted list replaces it. */
  loadout: SourceText | null;
  stratagems: StratagemFile | null;
  /** Lists checked against every HARD rule and scored on the same metric (no search). A pasted list is added automatically. */
  baselines?: SourceText[];
  /** Faction of the default collection (Lee's: Black Templars). Lee's house rules and collection caps apply only to this army. */
  collectionFaction?: string;
}
export interface RunCoreInput { army: string; detachment: string[] | 'all'; disposition: string; input?: { text: string; name: string } | null; base: OptimizeOptions; }
export interface RunProgress extends OptimizeProgress { run: number; runs: number; detachments: string[]; }
export interface RunEnv { cache?: CellStore; onProgress?: (p: RunProgress) => void; }

/** Pasted text: JSON with `units` -> collection; anything else -> a 40k-App list used as the loadout source. */
export function classifyInput(text: string): 'collection' | 'list' {
  try { const d = JSON.parse(text); if (d && Array.isArray(d.units)) return 'collection'; } catch { /* not JSON */ }
  return 'list';
}

export function runOptimizeCore(cat: CatalogIndex, r: RunCoreInput, data: RunData, env: RunEnv = {}) {
  const disposition = parseDisposition(r.disposition);
  let col: Collection = data.collection;
  let loadout = data.loadout;
  const inputNote: string[] = [];
  const baselines: SourceText[] = [...(data.baselines ?? [])];
  const ownFaction = data.collectionFaction ?? 'Black Templars';
  let leeHouseRules = norm(r.army) === norm(ownFaction);
  if (r.input && r.input.text.trim()) {
    const kind = classifyInput(r.input.text);
    if (kind === 'collection') { col = parseCollection(r.input.text, r.input.name); inputNote.push(`input ${r.input.name} used as the collection (owned-model caps)`); }
    else {
      loadout = { file: r.input.name, text: r.input.text }; baselines.push(loadout);
      if (norm(r.army) !== norm(ownFaction)) {
        // a non-owned faction: Lee's Black Templars collection must not cap it -> the pasted list is the unit pool
        const roster = parseList(r.input.text, { catalog: cat, sourceFile: r.input.name });
        col = collectionFromRoster(roster, `${r.input.name} (unit pool)`);
        inputNote.push(`${r.army} is not the collection's faction (${ownFaction}): Lee's collection limits are NOT applied; the pasted list is the unit pool (${col.units.length} datasheets, as many copies/models as it fields) and its wargear source. Lee's house rules (no unattached characters, Sword Brethren cap) are off.`);
      } else inputNote.push(`input ${r.input.name} used as the loadout source (unit wargear) and checked as a baseline list against every HARD rule; owned-model caps still from ${data.collection.path}`);
    }
  } else if (norm(r.army) !== norm(ownFaction)) {
    inputNote.push(`${r.army} is not the collection's faction (${ownFaction}) and nothing was pasted: Lee's collection is used as the unit pool, so only units it owns that ${r.army} can field are considered. Paste a ${r.army} list or collection to use its units.`);
  }
  leeHouseRules = leeHouseRules && r.base.leeHouseRules !== false;
  if (col.status !== 'loaded') throw new Error(`collection ${col.status} at ${col.path}${col.error ? `: ${col.error}` : ''}`);
  const avail = detachmentsFor(cat, r.army);
  const runs: string[][] = r.detachment === 'all' ? avail.filter((d) => d.dispositions.includes(disposition)).map((d) => [d.name]) : [r.detachment];
  const skipped = r.detachment === 'all' ? avail.filter((d) => !d.dispositions.includes(disposition)).map((d) => `${d.name} (grants ${d.dispositions.join(', ') || 'none'})`) : [];
  const per = runs.map((dets, ri) => {
    const sel = resolveSelection(cat, r.army, dets, disposition, r.base.points, data.stratagems);
    const o: OptimizeOptions = { ...r.base, leeHouseRules, faction: r.army, detachments: sel.detachments.map((d) => d.name), mission: missionKey(disposition), disposition, chapterLocked: chapterLocked(sel), loadoutList: loadout?.file ?? null };
    const res = optimizeCore(cat, col, { opponents: data.opponents, loadout, baselines }, o, {
      ...(env.cache ? { cache: env.cache } : {}),
      ...(env.onProgress ? { onProgress: (p: OptimizeProgress) => env.onProgress!({ ...p, run: ri + 1, runs: runs.length, detachments: o.detachments }) } : {}),
    });
    const best = res.results[0] as { score: number; roster: unknown } | undefined;
    return { detachments: o.detachments, gaps: sel.gaps, options: o, best: best ? { score: best.score, text: toGwAppText(best.roster as never) } : null, res };
  });
  const ranking = per.map((p) => ({ detachments: p.detachments.join(' + '), bestScore: p.best?.score ?? null })).sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1));
  const winner = [...per].sort((a, b) => (b.best?.score ?? -1) - (a.best?.score ?? -1))[0];
  return { army: r.army, disposition, tierTarget: dispositionMedians()[disposition], inputNote, skipped, ranking, per, winner };
}

export type RunResult = ReturnType<typeof runOptimizeCore>;

type Infeasibility = { message: string; closest: { failingBands: string[]; tankKillers: number; points: number; score: number; units: string[] }[]; dedicatedTankKillers?: { message: string } | null } | null;
/** Human-readable infeasibility report (why no list met every HARD rule, and the closest lists). */
export function infeasibilityText(dets: string[], inf: Infeasibility): string {
  if (!inf) return '';
  const out = [`# [${dets.join(' + ')}] ${inf.message}`];
  if (inf.dedicatedTankKillers && inf.dedicatedTankKillers.message !== inf.message) out.push(`# ${inf.dedicatedTankKillers.message}`);
  inf.closest.slice(0, 2).forEach((c, i) => out.push(`# closest #${i + 1} (${c.points} pts, score ${c.score}; failing bands: ${c.failingBands.join(', ') || 'none'}): ${c.units.join('; ')}`));
  return out.join('\n') + '\n';
}

type BaselineRow = { name: string; file: string; score: number; points: number; hard: { feasible: boolean; failing: string[] } };
/** One line per baseline list: HARD-rule verdict (with the failing rules and numbers) and its score on the same metric. */
export function baselineText(run: RunResult): string {
  return run.per.flatMap((p) => (p.res.baselines as BaselineRow[]).map((b) => `# baseline [${p.detachments.join(' + ')}] ${b.name || b.file} (${b.points} pts, score ${b.score}): ${b.hard.feasible ? 'meets every HARD rule' : `FAILS ${b.hard.failing.join('; ')}`}`)).join('\n') + (run.per.some((p) => p.res.baselines.length) ? '\n' : '');
}

export function bestText(run: RunResult): string {
  const w = run.winner;
  if (!w?.best) {
    return `No feasible list for ${run.army} / ${run.disposition}.\n` + run.per.map((p) => infeasibilityText(p.detachments, p.res.infeasibility)).join('') + baselineText(run);
  }
  return w.best.text.trimEnd() + `\n\n# crucible optimize: army ${run.army}; detachment ${w.detachments.join(' + ')}; disposition ${run.disposition}; score ${w.best.score}\n`
    + (run.ranking.length > 1 ? `# detachment ranking: ${run.ranking.map((x) => `${x.detachments} ${x.bestScore ?? 'n/a'}`).join('; ')}\n` : '') + baselineText(run);
}
