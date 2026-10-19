/**
 * Toughness-band damage check (list guide step 04). HEURISTIC encoding of:
 *   "At least two units for every toughness band: units that can remove 80+ points of a target in that band in one activation."
 * Lee's decision 2026-10-19: points removed = SHARE OF WOUNDS dealt, min(1, expected wounds / target total wounds) x target points
 * (was P(kill) x points for single-model targets). Threshold default 80, capped at 80% of the reference unit's points so bands whose
 * BSData reference costs under 80 (Cadian Shock Troops x10 = 70, Rhino = 70) stay reachable.
 */
export const BAND_THRESHOLD = 80;
export const BAND_GUIDE_QUOTE = 'At least two units for every toughness band: units that can remove 80+ points of a target in that band in one activation.';
export const bandThreshold = (refPts: number, threshold = BAND_THRESHOLD) => Math.min(threshold, 0.8 * refPts);
/** Expected points removed as a share of wounds: min(1, expected wounds / total wounds) x points. */
export const bandPoints = (expDamage: number, totalWounds: number, pts: number) => Math.min(1, expDamage / Math.max(1, totalWounds)) * pts;
export const totalWounds = (def: { groups: { count: number; W: number }[] }) => def.groups.reduce((a, g) => a + g.count * g.W, 0);
export function bandPasses(c: { expDamage: number }, ref: { pts: number; def: { groups: { count: number; W: number }[] } }, threshold = BAND_THRESHOLD): boolean {
  return bandPoints(c.expDamage, totalWounds(ref.def), ref.pts) >= bandThreshold(ref.pts, threshold);
}
export const BAND_DEF = `HEURISTIC (guide 04: "${BAND_GUIDE_QUOTE}"): a unit passes a band when min(1, expected wounds / target total wounds) x target points >= the threshold (default ${BAND_THRESHOLD}, capped at 80% of the reference unit's points) in one exact-engine activation vs that band's BSData reference unit. Share-of-wounds measure per Lee 2026-10-19.`;
