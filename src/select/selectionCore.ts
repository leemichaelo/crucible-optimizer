/** Army / detachment / disposition selection (pure; selection.ts adds the Node file defaults). Detachments come only from BSData (catalog.detachments); dispositions from missions.json. */
import { stratagemsFor, type StratagemFile } from '../rules/stratagemsCore.ts';
import { offensiveStratsFor, RULE_EFFECTS, ENHANCEMENT_EFFECTS } from '../rules/detachments.ts';
import type { CatalogIndex } from '../catalog/core.ts';
import { norm } from '../bsdata/parse.ts';
import type { Detachment, Enhancement } from '../types.ts';
import { GUIDE_TERMS } from '../guide/terms.ts';

export const DISPOSITIONS = ['Take and Hold', 'Disruption', 'Purge the Foe', 'Priority Assets', 'Reconnaissance'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** Legacy --mission keys and loose spellings -> canonical disposition. */
const ALIASES: Record<string, Disposition> = { purge: 'Purge the Foe', 'purge-the-foe': 'Purge the Foe', 'take-and-hold': 'Take and Hold', th: 'Take and Hold', recon: 'Reconnaissance' };
export function parseDisposition(x: string): Disposition {
  const k = x.trim().toLowerCase();
  if (ALIASES[k]) return ALIASES[k]!;
  const hit = DISPOSITIONS.find((d) => norm(d) === norm(k.replace(/-/g, ' ')));
  if (!hit) throw new Error(`unknown disposition "${x}"; one of: ${DISPOSITIONS.join(', ')}`);
  return hit;
}
/** Optimizer mission key (weights/tier-target key). Only 'purge' has its own weights; the rest use the default weights. */
export function missionKey(d: Disposition): string { return d === 'Purge the Foe' ? 'purge' : norm(d).replace(/ /g, '-'); }

/** Tier-shape medians parsed from the list-guide quote (GUIDE_TERMS 'disposition-medians'), so they stay sourced. */
export function dispositionMedians(): Record<Disposition, [number, number, number]> {
  const q = GUIDE_TERMS.find((t) => t.id === 'disposition-medians')!.quote;
  const out = {} as Record<Disposition, [number, number, number]>;
  for (const d of DISPOSITIONS) {
    const m = q.match(new RegExp(`${d.toUpperCase()} (\\d+)·(\\d+)·(\\d+)`));
    if (!m) throw new Error(`guide quote lacks ${d}`);
    out[d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return out;
}

/** Army name -> its own BSData catalogue (exact or suffix match, non-library). */
export function armyCatalogue(cat: CatalogIndex, army: string): string {
  const f = norm(army);
  const c = cat.cat.catalogues.filter((x) => !x.library).find((x) => norm(x.name) === f || norm(x.name).endsWith(' ' + f));
  if (!c) throw new Error(`army "${army}" not found among BSData catalogues`);
  return c.name;
}

/** Detachments an army may take: defined in its scope and not hidden for it (BSData 'hidden unless instanceOf' modifiers). */
export function detachmentsFor(cat: CatalogIndex, army: string): Detachment[] {
  const own = armyCatalogue(cat, army);
  const scope = cat.scope(army);
  // Library catalogues (e.g. Imperial Knights - Library, imported for allies) contribute units, not the army's own detachments.
  const lib = new Set(cat.cat.catalogues.filter((c) => c.library).map((c) => c.name));
  return (cat.cat.detachments ?? []).filter((d) => scope.includes(d.catalogue) && !lib.has(d.catalogue) && !d.errors.length && (!d.onlyFor.length || d.onlyFor.includes(own)));
}

export function enhancementsFor(cat: CatalogIndex, army: string, detachments: string[]): Enhancement[] {
  const scope = cat.scope(army);
  return cat.cat.enhancements.filter((e) => scope.includes(e.catalogue) && detachments.some((d) => norm(d) === norm(e.detachment)));
}

export interface Selection { army: string; armyCatalogue: string; detachments: Detachment[]; disposition: Disposition; gaps: string[]; }

/** Validate the three selections against BSData. Throws on hard errors (unknown/unavailable detachment, disposition not granted). */
export function resolveSelection(cat: CatalogIndex, army: string, detNames: string[], disposition: Disposition, pointsLimit = 2000, strats: StratagemFile | null = null): Selection {
  if (detNames.length > MAX_DETACHMENTS) throw new Error(`at most ${MAX_DETACHMENTS} detachments can be combined (total also capped by the BSData Detachment Points limit); got ${detNames.length}: ${detNames.join(', ')}`);
  const avail = detachmentsFor(cat, army);
  const sf = stratagemsFor(detNames, strats);
  const gaps: string[] = [sf.label === 'UNAVAILABLE' ? `BSData d506fcc has no stratagem entries; SECONDARY stratagem file missing (${(sf as { blocker?: string }).blocker}).` : `BSData d506fcc has no stratagem entries; stratagems come from a SECONDARY source (${(sf as { source?: { url: string; retrieved: string } }).source?.url}, retrieved ${(sf as { source?: { retrieved: string } }).source?.retrieved}) and are filtered to the chosen detachment(s): ${sf.stratagems.length} found${sf.missing.length ? `; none found for ${sf.missing.join(', ')}` : ''}. Offensive ones in the engine: ${offensiveStratsFor(detNames).join(', ') || 'none'}.`];
  const dets = detNames.map((n) => {
    const d = avail.find((x) => norm(x.name) === norm(n));
    if (!d) {
      const any = (cat.cat.detachments ?? []).find((x) => norm(x.name) === norm(n));
      throw new Error(any ? `detachment "${any.name}" is not available to ${army} in BSData (${any.errors[0] ?? `hidden unless ${any.onlyFor.join('/')}`})` : `detachment "${n}" not found in BSData; see list-detachments --army "${army}"`);
    }
    return d;
  });
  const granted = new Set(dets.flatMap((d) => d.dispositions));
  if (!granted.has(disposition)) throw new Error(`disposition ${disposition} is not granted by ${dets.map((d) => `${d.name} [${d.dispositions.join(', ') || 'none in BSData'}]`).join(' + ')} (BSData categoryLinks)`);
  for (const d of dets) {
    if (!enhancementsFor(cat, army, [d.name]).length) gaps.push(`${d.name}: no enhancements in BSData.`);
    if (d.rules.some((r) => /^new rule$/i.test(r.name))) gaps.push(`${d.name}: detachment rule is named "New Rule" in BSData (placeholder name; text present).`);
    if (d.restrictions === '') gaps.push(`${d.name}: "Restrictions:" heading present but empty in BSData.`);
    const re = RULE_EFFECTS[d.name];
    gaps.push(re ? ([...re.attack, ...re.defence].length ? `${d.name}: detachment rule ${re.rule} modelled as ${[...re.attack, ...re.defence].join(', ')} (src/rules/detachments.ts).` : `${d.name}: detachment rule ${re.rule} not modelled: ${re.gap}.`) : `${d.name}: detachment rule effects (${d.rules.map((r) => r.name).join(', ')}) are not modelled by the dice engine.`);
    const enhGaps = enhancementsFor(cat, army, [d.name]).map((e) => { const x = ENHANCEMENT_EFFECTS[e.name]; return x?.gap ? `${e.name} (${x.gap})` : x ? null : `${e.name} (no effect entry)`; }).filter(Boolean);
    if (enhGaps.length) gaps.push(`${d.name}: enhancement effects not (fully) modelled: ${enhGaps.join('; ')}.`);
  }
  if (dets.length > 1) {
    const missingDp = dets.filter((d) => d.detachmentPoints === null).map((d) => d.name);
    const dp = dets.reduce((s, d) => s + (d.detachmentPoints ?? 0), 0);
    const lim = detachmentPointLimit(pointsLimit);
    if (missingDp.length) gaps.push(`GAP: BSData has no Detachment Points cost for ${missingDp.join(', ')}; the DP total is not checked.`);
    else if (lim === null) gaps.push(`GAP: no BSData Detachment Points limit known for a ${pointsLimit}-pt game; ${dp} DP not checked.`);
    else if (dp > lim.max) throw new Error(`detachments ${dets.map((d) => `${d.name} (${d.detachmentPoints} DP)`).join(' + ')} = ${dp} DP exceeds the ${lim.max} DP limit for ${lim.battleSize} (${lim.source})`);
    else gaps.push(`Detachments: ${dets.map((d) => `${d.name} ${d.detachmentPoints} DP`).join(' + ')} = ${dp}/${lim.max} DP for ${lim.battleSize} (${lim.source}). Disposition valid if granted by any of them; enhancements, stratagems and rules are the union of all of them.`);
  }
  return { army, armyCatalogue: armyCatalogue(cat, army), detachments: dets, disposition, gaps };
}

/** Restriction text 'cannot include any ADEPTUS ASTARTES units drawn from any other Chapter' -> unit must come from the army catalogue or a non-chapter catalogue. */
export function chapterLocked(sel: Selection): boolean {
  return sel.detachments.some((d) => /cannot include any\s+ADEPTUS ASTARTES units drawn from any\s+other Chapter/i.test((d.restrictions ?? '').replace(/\u00a0/g, ' ')));
}

/**
 * Roster Detachment Points limit, from BSData wh40k-11e @d506fcc "Warhammer 40,000.json": cost type "Detachment Points"
 * (82ae-1066-5107-6ae0), Army Roster constraint 95c5-effd-74f1-c8f4 max 2, set to 3 for "2. Strike Force (2000 Point limit)"
 * (or Incursion with a "3DP Detachment"), set to 4 for "3. Onslaught (3000 Point limit)". Checked against the file in test/detachments.test.ts.
 */
/** Most detachments the page/CLI combine (Strike Force: 3 DP, so three 1-DP detachments). */
export const MAX_DETACHMENTS = 3;
export const DP_LIMITS = [
  { maxPoints: 1000, battleSize: '1. Incursion (1000 Point limit)', max: 2 },
  { maxPoints: 2000, battleSize: '2. Strike Force (2000 Point limit)', max: 3 },
  { maxPoints: 3000, battleSize: '3. Onslaught (3000 Point limit)', max: 4 },
] as const;
export function detachmentPointLimit(points: number): { max: number; battleSize: string; source: string } | null {
  const b = DP_LIMITS.find((x) => points <= x.maxPoints);
  return b ? { max: b.max, battleSize: b.battleSize, source: 'BSData Warhammer 40,000.json constraint 95c5-effd-74f1-c8f4' } : null;
}
