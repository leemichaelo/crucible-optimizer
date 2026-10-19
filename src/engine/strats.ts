/**
 * Black Templars stratagems and abilities modelled as declared modifiers.
 * Rule text: /workspace/codex-rebuild/scoutB-reference-card.md (BSData wins on conflict).
 */
import type { Modifiers } from './types.ts';

export interface StratContext {
  attackerKeywords: string[]; // lowercase, union over attacking units
  attackerUnits: string[]; // lowercase unit names
  defenderKeywords: string[];
  defenderUnits: string[];
}

export interface StratDef {
  id: string;
  name: string;
  cp: number | null;
  /** Dice effect summary; "none" for sequencing-only rules. */
  effect: string;
  /** Detachment that grants it (null = core / datasheet / always available). Used to filter by the chosen detachment. */
  detachment?: string | null;
  /** Where the rule text comes from. */
  source?: string;
  apply: (m: Modifiers, ctx: StratContext) => { ok: boolean; reason?: string };
}

const has = (list: string[], ...k: string[]) => k.some((x) => list.includes(x));

export const STRATS: StratDef[] = [
  {
    id: 'avowed-destruction:lethal', detachment: 'Fist of the God-Emperor', name: 'Avowed Destruction (Lethal Hits)', cp: 1, effect: 'melee [LETHAL HITS]; CRUSADER SQUAD only',
    apply: (m, c) => has(c.attackerUnits, 'crusader squad') ? (m.meleeOnly.lethalHits = true, { ok: true }) : { ok: false, reason: 'attacker is not a CRUSADER SQUAD' },
  },
  {
    id: 'avowed-destruction:sustained', detachment: 'Fist of the God-Emperor', name: 'Avowed Destruction (Sustained Hits 1)', cp: 1, effect: 'melee [SUSTAINED HITS 1]; CRUSADER SQUAD only',
    apply: (m, c) => has(c.attackerUnits, 'crusader squad') ? (m.meleeOnly.sustainedHits = 1, { ok: true }) : { ok: false, reason: 'attacker is not a CRUSADER SQUAD' },
  },
  {
    id: 'angels-defiant', detachment: 'Fist of the God-Emperor', name: 'Angels Defiant', cp: 1, effect: '-1 to wound for attacks with S > T against a CRUSADER SQUAD',
    apply: (m, c) => has(c.defenderUnits, 'crusader squad') ? (m.minusOneWoundIfSgtT = true, { ok: true }) : { ok: false, reason: 'defender is not a CRUSADER SQUAD' },
  },
  {
    id: 'for-the-emperors-honour', detachment: 'Vow-sworn Crusaders', name: "For the Emperor's Honour!", cp: 1, effect: 'melee [PRECISION]; ADEPTUS ASTARTES INFANTRY',
    apply: (m, c) => has(c.attackerKeywords, 'infantry') ? (m.meleeOnly.precision = true, { ok: true }) : { ok: false, reason: 'attacker is not INFANTRY' },
  },
  {
    id: 'pious-enmity', detachment: 'Vow-sworn Crusaders', name: 'Pious Enmity (hit 1s)', cp: 1, effect: 'melee re-roll hit rolls of 1; CHAPLAIN/JUDICIAR unit',
    apply: (m, c) => has(c.attackerKeywords, 'chaplain', 'judiciar') ? (m.meleeOnly.rerollHits = 'ones', { ok: true }) : { ok: false, reason: 'no CHAPLAIN/JUDICIAR in attacking unit' },
  },
  {
    id: 'pious-enmity:monster-vehicle', detachment: 'Vow-sworn Crusaders', name: 'Pious Enmity (hit+wound 1s vs MONSTER/VEHICLE)', cp: 1, effect: 'melee re-roll hit 1s and wound 1s vs MONSTER/VEHICLE',
    apply: (m, c) => {
      if (!has(c.attackerKeywords, 'chaplain', 'judiciar')) return { ok: false, reason: 'no CHAPLAIN/JUDICIAR in attacking unit' };
      if (!has(c.defenderKeywords, 'monster', 'vehicle')) return { ok: false, reason: 'defender is not MONSTER/VEHICLE' };
      m.meleeOnly.rerollHits = 'ones'; m.meleeOnly.rerollWounds = 'ones'; return { ok: true };
    },
  },
  {
    id: 'spoor-of-the-unholy', detachment: 'Vow-sworn Crusaders', name: 'Spoor of the Unholy', cp: 1, effect: 'ignore modifiers to BS/WS and hit rolls (modelled: negative hit modifiers incl. cover ignored)',
    apply: (m) => (m.ignoreHitMods = true, { ok: true }),
  },
  {
    id: 'might-of-angels', detachment: 'Gladius Task Force', source: 'SECONDARY data/stratagems.json (Wahapedia 11e BT page, retrieved 2026-10-15)', name: 'Might of Angels', cp: 1, effect: 'melee [LANCE] (+1 to wound having charged); ADEPTUS ASTARTES',
    apply: (m, c) => has(c.attackerKeywords, 'adeptus astartes') ? (m.meleeOnly.woundMod = (m.meleeOnly.woundMod ?? 0) + (m.charged ? 1 : 0), { ok: true }) : { ok: false, reason: 'attacker is not ADEPTUS ASTARTES' },
  },
  {
    id: 'gene-wrought-might', detachment: 'Assault Brethren', source: 'SECONDARY data/stratagems.json (Wahapedia 11e BT page, retrieved 2026-10-15)', name: 'Gene-wrought Might', cp: 1, effect: 'melee [LANCE] (+1 to wound having charged). The assault-doctrine variant (+1 AP) is NOT applied (doctrine uses are limited per battle).',
    apply: (m, c) => has(c.attackerKeywords, 'adeptus astartes') ? (m.meleeOnly.woundMod = (m.meleeOnly.woundMod ?? 0) + (m.charged ? 1 : 0), { ok: true }) : { ok: false, reason: 'attacker is not ADEPTUS ASTARTES' },
  },
  {
    id: 'relentless-assault', detachment: 'Tacticus Attack Force', source: 'SECONDARY data/stratagems.json (Wahapedia 11e BT page, retrieved 2026-10-15)', name: 'Relentless Assault', cp: 1, effect: 'all attacks [SUSTAINED HITS 1] vs non-MONSTER/VEHICLE, or [LETHAL HITS] vs MONSTER/VEHICLE; TACTICUS unit',
    apply: (m, c) => {
      if (!has(c.attackerKeywords, 'tacticus')) return { ok: false, reason: 'attacker is not TACTICUS' };
      if (has(c.defenderKeywords, 'monster', 'vehicle')) m.lethalHits = true; else m.sustainedHits = Math.max(m.sustainedHits, 1);
      return { ok: true };
    },
  },
  {
    id: 'annihilating-force', detachment: 'Gravis Linebreaker Force|Gravis Siege Force', source: 'SECONDARY data/stratagems.json (Wahapedia 11e BT page, retrieved 2026-10-15)', name: 'Annihilating Force', cp: 1, effect: 'all attacks [LETHAL HITS]; GRAVIS unit',
    apply: (m, c) => has(c.attackerKeywords, 'gravis') ? (m.lethalHits = true, { ok: true }) : { ok: false, reason: 'attacker is not GRAVIS' },
  },
  {
    id: 'counteroffensive', name: 'Counteroffensive', cp: 2, effect: 'none (Fights First sequencing only; no dice change)',
    apply: () => ({ ok: true }),
  },
];

export const ABILITIES: StratDef[] = [
  {
    id: 'vow:accept-any-challenge', name: 'Templar Vow: Accept Any Challenge, No Matter the Odds', cp: null, effect: '+1 to wound for melee attacks when target T > attack S',
    apply: (m) => (m.meleeOnly.plusOneWoundIfTgtS = true, { ok: true }),
  },
  {
    id: 'vow:abhor-the-witch', name: 'Templar Vow: Abhor the Witch, Destroy the Witch', cp: null, effect: 'melee [PRECISION] and [LANCE] vs PSYKER',
    apply: (m, c) => has(c.defenderKeywords, 'psyker') ? (m.meleeOnly.precision = true, m.meleeOnly.woundMod = (m.meleeOnly.woundMod ?? 0) + (m.charged ? 1 : 0), { ok: true }) : { ok: false, reason: 'defender is not PSYKER' },
  },
  {
    id: 'vow:uphold-the-honour', name: 'Templar Vow: Uphold the Honour of the Emperor', cp: null, effect: 'none (objective/action rule)', apply: () => ({ ok: true }),
  },
  {
    id: 'judiciar-fights-first', name: 'Judiciar: Tempormortis (Fights First)', cp: null, effect: 'none (sequencing only)',
    apply: (_m, c) => has(c.attackerKeywords, 'judiciar') ? { ok: true } : { ok: false, reason: 'no JUDICIAR in attacking unit' },
  },
  {
    id: 'walking-fortress', detachment: 'Gravis Linebreaker Force', source: 'BSData detachment/enhancement text (catalog.json)', name: 'Walking Fortress (detachment rule)', cp: null, effect: 'ranged +1 to hit for a GRAVIS unit that made a normal move (assumed moved; [HEAVY] bonus forgone)',
    apply: (m, c) => has(c.attackerKeywords, 'gravis') ? (m.rangedOnly = { ...(m.rangedOnly ?? {}), hitMod: (m.rangedOnly?.hitMod ?? m.hitMod) + 1 }, { ok: true }) : { ok: false, reason: 'attacker is not GRAVIS' },
  },
  {
    id: 'indomitable-defence', detachment: 'Gravis Siege Force', source: 'BSData detachment/enhancement text (catalog.json)', name: 'Indomitable Defence (detachment rule)', cp: null, effect: 'DEFENSIVE: -1 to wound for attacks with S > T against a GRAVIS unit within range of an objective (assumed on an objective: Take and Hold)',
    apply: (m, c) => has(c.defenderKeywords, 'gravis') ? (m.minusOneWoundIfSgtT = true, { ok: true }) : { ok: false, reason: 'defender is not GRAVIS' },
  },
  {
    id: 'indefatigable-fortitude', detachment: 'Gravis Linebreaker Force', source: 'BSData detachment/enhancement text (catalog.json)', name: 'Indefatigable Fortitude (enhancement)', cp: null, effect: 'DEFENSIVE: -1 to wound for attacks with S > T against the bearer\'s unit',
    apply: (m) => (m.minusOneWoundIfSgtT = true, { ok: true }),
  },
  {
    id: 'furious-assault', detachment: 'Assault Brethren', source: 'BSData detachment/enhancement text (catalog.json)', name: 'Furious Assault (upgrade enhancement)', cp: null, effect: 'melee [SUSTAINED HITS 1] vs non-MONSTER/VEHICLE',
    apply: (m, c) => has(c.defenderKeywords, 'monster', 'vehicle') ? { ok: false, reason: 'defender is MONSTER/VEHICLE' } : (m.meleeOnly.sustainedHits = Math.max(m.meleeOnly.sustainedHits ?? 0, 1), { ok: true }),
  },
  {
    id: 'angels-defiant:block', detachment: 'Fist of the God-Emperor', source: 'SECONDARY data/stratagems.json (Wahapedia 11e BT page, retrieved 2026-10-15)', name: 'Angels Defiant (points-at-risk; caller checks the block contains a CRUSADER SQUAD)', cp: null,
    effect: 'DEFENSIVE: -1 to wound for attacks with S > T against the block (same effect as angels-defiant; eligibility decided by the optimizer, since attached-unit names are combined)',
    apply: (m) => (m.minusOneWoundIfSgtT = true, { ok: true }),
  },
  {
    id: 'incendiary-animus', name: 'Incendiary Animus (enhancement)', cp: null, effect: 'melee +1 S',
    apply: (m) => (m.meleeOnly.strengthBonus = (m.meleeOnly.strengthBonus ?? 0) + 1, { ok: true }),
  },
];

export function findRule(id: string): StratDef | undefined {
  const k = id.toLowerCase();
  return [...STRATS, ...ABILITIES].find((s) => s.id === k);
}
