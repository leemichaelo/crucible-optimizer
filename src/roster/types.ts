/** Unified roster model produced by every parser. */

export type RosterFormat = 'gw-app' | 'bcp' | 'newrecruit-text' | 'newrecruit-json' | 'unknown';

export interface WargearLine { name: string; count: number; }

export interface ModelLine {
  name: string;
  count: number;
  wargear: WargearLine[];
}

export interface RosterUnit {
  name: string;
  /** Points as pasted in the source list (null if absent). */
  pastedPts: number | null;
  models: ModelLine[];
  /** Wargear lines that could not be tied to a model line (single-model units, flattened pastes). */
  unitWargear: WargearLine[];
  modelCount: number;
  enhancement: string | null;
  enhancementPts: number | null;
  warlord: boolean;
  attachedAs: 'Leader' | 'Support' | 'Bodyguard' | null;
  /** Index of the attached-unit block (1-based) or null. */
  attachGroup: number | null;
  /** For New Recruit text: the unit name this one leads/supports. */
  attachTarget: string | null;
  section: string | null;
}

export interface Roster {
  format: RosterFormat;
  sourceFile: string | null;
  name: string | null;
  player: string | null;
  faction: string | null;
  factionLines: string[];
  detachments: string[];
  mission: string | null;
  battleSize: string | null;
  declaredPoints: number | null;
  units: RosterUnit[];
  warnings: string[];
}

export function emptyUnit(name: string, pts: number | null): RosterUnit {
  return {
    name, pastedPts: pts, models: [], unitWargear: [], modelCount: 0, enhancement: null, enhancementPts: null,
    warlord: false, attachedAs: null, attachGroup: null, attachTarget: null, section: null,
  };
}
