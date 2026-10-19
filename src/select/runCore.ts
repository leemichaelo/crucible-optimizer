/** Shared optimize entry (pure): three selections + data in, ranked lists + export text out. Used by the Node CLI/page (run.ts) and the browser worker. */
import type { CatalogIndex } from '../catalog/core.ts';
import { parseCollection, type Collection } from '../validate/collectionCore.ts';
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
  if (r.input && r.input.text.trim()) {
    const kind = classifyInput(r.input.text);
    if (kind === 'collection') { col = parseCollection(r.input.text, r.input.name); inputNote.push(`input ${r.input.name} used as the collection (owned-model caps)`); }
    else { loadout = { file: r.input.name, text: r.input.text }; inputNote.push(`input ${r.input.name} used as the loadout source (unit wargear); owned-model caps still from ${data.collection.path}`); }
  }
  if (col.status !== 'loaded') throw new Error(`collection ${col.status} at ${col.path}${col.error ? `: ${col.error}` : ''}`);
  const avail = detachmentsFor(cat, r.army);
  const runs: string[][] = r.detachment === 'all' ? avail.filter((d) => d.dispositions.includes(disposition)).map((d) => [d.name]) : [r.detachment];
  const skipped = r.detachment === 'all' ? avail.filter((d) => !d.dispositions.includes(disposition)).map((d) => `${d.name} (grants ${d.dispositions.join(', ') || 'none'})`) : [];
  const per = runs.map((dets, ri) => {
    const sel = resolveSelection(cat, r.army, dets, disposition, r.base.points, data.stratagems);
    const o: OptimizeOptions = { ...r.base, faction: r.army, detachments: sel.detachments.map((d) => d.name), mission: missionKey(disposition), disposition, chapterLocked: chapterLocked(sel), loadoutList: loadout?.file ?? null };
    const res = optimizeCore(cat, col, { opponents: data.opponents, loadout }, o, {
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

export function bestText(run: RunResult): string {
  const w = run.winner;
  if (!w?.best) {
    return `No feasible list for ${run.army} / ${run.disposition}.\n` + run.per.map((p) => infeasibilityText(p.detachments, p.res.infeasibility)).join('');
  }
  return w.best.text.trimEnd() + `\n\n# crucible optimize: army ${run.army}; detachment ${w.detachments.join(' + ')}; disposition ${run.disposition}; score ${w.best.score}\n`
    + (run.ranking.length > 1 ? `# detachment ranking: ${run.ranking.map((x) => `${x.detachments} ${x.bestScore ?? 'n/a'}`).join('; ')}\n` : '');
}
