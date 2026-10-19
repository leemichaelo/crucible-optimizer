/** Engine input/output types. Engine is pure: no I/O, no catalog access. */

export type Reroll = 'none' | 'ones' | 'all';

export interface EngineWeapon {
  name: string;
  type: 'ranged' | 'melee';
  /** Number of models firing/fighting with this weapon. */
  copies: number;
  /** Attacks per copy (dice expr). */
  A: string;
  /** BS/WS target; null with torrent. */
  skill: number | null;
  S: number;
  /** AP as printed (0, -1, -2 ...). */
  AP: number;
  D: string;
  lethalHits?: boolean;
  sustainedHits?: number | string; // number or dice expr
  devastatingWounds?: boolean;
  twinLinked?: boolean;
  torrent?: boolean;
  precision?: boolean;
  lance?: boolean;
  heavy?: boolean;
  ignoresCover?: boolean;
  blast?: number;
  melta?: number;
  rapidFire?: number | string;
  /** Anti-X: list of [keyword (lowercase), critOn]. */
  anti?: [string, number][];
}

export interface DefenderGroup {
  name: string;
  count: number;
  W: number;
  Sv: number;
  InSv: number | null;
  /** Feel No Pain target, or null. */
  fnp: number | null;
  character: boolean;
}

export interface Defender {
  name: string;
  T: number;
  keywords: string[]; // lowercase
  groups: DefenderGroup[];
}

/** Declared modifiers for one attack sequence. */
export interface Modifiers {
  hitMod: number;
  woundMod: number;
  rerollHits: Reroll;
  rerollWounds: Reroll;
  /** Spoor of the Unholy: ignore (negative) modifiers to BS/WS and hit rolls. */
  ignoreHitMods: boolean;
  /** Force-grant abilities to all weapons in the sequence. */
  lethalHits: boolean;
  sustainedHits: number;
  devastatingWounds: boolean;
  precision: boolean;
  /** Target has benefit of cover (11e 13.08: ranged BS worsened by 1). */
  cover: boolean;
  halfRange: boolean;
  charged: boolean;
  stationary: boolean;
  strengthBonus: number;
  attacksBonus: number;
  apBonus: number;
  /** Modifier to the defender's armour save roll (+1 = easier to save). Not capped. */
  saveMod: number;
  /** Modifier to D (floored at 1). */
  damageMod: number;
  /** -1 wound when attack S > target T (Angels Defiant). */
  minusOneWoundIfSgtT: boolean;
  /** +1 wound when target T > attack S (Accept Any Challenge vow). */
  plusOneWoundIfTgtS: boolean;
  /** Apply only to melee / ranged weapon types (e.g. Avowed Destruction is melee only). */
  meleeOnly: Partial<Omit<Modifiers, 'meleeOnly'>>;
  /** Apply only to ranged weapons (e.g. Walking Fortress +1 to hit). Optional for backwards compatibility. */
  rangedOnly?: Partial<Omit<Modifiers, 'meleeOnly' | 'rangedOnly'>>;
  /** SOURCED (App Rules Commentary 02.02.01): net hit and wound modifiers capped at +/-1. */
  capModifiers: boolean;
}

export const NO_MODS: Modifiers = {
  hitMod: 0, woundMod: 0, rerollHits: 'none', rerollWounds: 'none', ignoreHitMods: false, lethalHits: false, sustainedHits: 0,
  devastatingWounds: false, precision: false, cover: false, halfRange: false, charged: false, stationary: false,
  strengthBonus: 0, attacksBonus: 0, apBonus: 0, saveMod: 0, damageMod: 0, minusOneWoundIfSgtT: false, plusOneWoundIfTgtS: false, meleeOnly: {}, capModifiers: true,
};

export interface SequenceResult {
  /** P(models killed = k), all groups. */
  killDist: number[];
  /** P(effective wounds removed = k) (overkill on a model is lost). */
  damageDist: number[];
  /** Per-group kill distributions. */
  groupKillDists: Record<string, number[]>;
  expectedKills: number;
  expectedDamage: number;
  pWipe: number;
  /** Per-weapon closed-form expected values (before overkill), for cross-checks. */
  perWeaponEV: { name: string; hits: number; wounds: number; unsaved: number; damage: number }[];
  assumptions: string[];
}
