/**
 * Unit exclude list: datasheets the optimizer must not field (exact BSData datasheet names, case/punctuation-insensitive;
 * "Captain" excludes only the plain Captain, not "Captain in Terminator Armour" or other variants).
 * Saved presets are Lee's own lists (not game rules).
 */
import { norm } from '../bsdata/parse.ts';

export interface ExcludePreset { name: string; source: string; units: string[]; }
export const EXCLUDE_PRESETS: ExcludePreset[] = [
  { name: 'Art of War C-or-below', source: "Lee's preset (2026-10-20): Art of War unit grades C or below",
    units: ['Ballistus Dreadnought', 'Assault Intercessor Squad', 'Judiciar', 'Captain', 'Ancient', 'Intercessor Squad', 'Rhino', 'Drop Pod'] },
];

/** "A,B" (CLI) -> names; a preset name expands to its units. */
export function parseExclude(s: string | string[] | undefined): string[] {
  const parts = (Array.isArray(s) ? s : s ? [s] : []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  return [...new Set(parts.flatMap((p) => EXCLUDE_PRESETS.find((x) => norm(x.name) === norm(p))?.units ?? [p]))];
}

export const isExcluded = (exclude: string[] | undefined, datasheet: string) => !!exclude?.some((x) => norm(x) === norm(datasheet));
