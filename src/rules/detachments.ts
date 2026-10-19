/**
 * Dice-math effects of detachment rules, enhancements and stratagems for the six Take-and-Hold detachments
 * Black Templars can take (BSData dispositions). Rule/enhancement text: BSData (catalog.json). Stratagem text:
 * SECONDARY (data/stratagems.json, Wahapedia). Anything not expressible as hit/wound/AP/S/reroll/lethal/sustained/
 * lance/crit/save modifiers in ONE activation is listed in GAPS, never approximated silently.
 */
import { STRATS } from '../engine/strats.ts';
import type { RosterUnit } from '../roster/types.ts';

export const TH_BT_DETACHMENTS = ['Fist of the God-Emperor', 'Gravis Linebreaker Force', 'Gravis Siege Force', 'Gladius Task Force', 'Assault Brethren', 'Tacticus Attack Force'];

const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const inDet = (det: string | null | undefined, chosen: string[]) => !det || det.split('|').some((d) => chosen.some((c) => n(c) === n(d)));

/** Strats that can raise our own damage in one activation. */
export const OFFENSIVE_STRAT_IDS = ['avowed-destruction:lethal', 'avowed-destruction:sustained', 'for-the-emperors-honour', 'pious-enmity', 'pious-enmity:monster-vehicle', 'might-of-angels', 'gene-wrought-might', 'relentless-assault', 'annihilating-force'];
/**
 * Like-for-like mode. 'generic' strips the generic Codex: Space Marines detachment damage stratagems (the same text family
 * appears across many Codex detachments: Might of Angels, Gene-wrought Might, Relentless Assault, Annihilating Force) and keeps
 * Black Templars-specific ones (Avowed Destruction, Vow-sworn strats). 'all' strips every offensive stratagem.
 */
export const GENERIC_STRAT_IDS = ['might-of-angels', 'gene-wrought-might', 'relentless-assault', 'annihilating-force'];
export type StripStrats = 'none' | 'generic' | 'all';
export function offensiveStratsFor(detachments: string[], strip: StripStrats = 'none'): string[] {
  if (strip === 'all') return [];
  return OFFENSIVE_STRAT_IDS.filter((id) => inDet(STRATS.find((s) => s.id === id)?.detachment, detachments) && !(strip === 'generic' && GENERIC_STRAT_IDS.includes(id)));
}

/**
 * Sourced rules text for the Fist of the God-Emperor / Vow-sworn Crusaders movement/objective value that the dice engine cannot
 * express. Scored by HEURISTIC list terms in src/optimize/search.ts (detachmentRules part); Angels Defiant feeds pointsAtRisk.
 * Quotes are verbatim; nothing here is paraphrased into rules.
 */
export const FIST_VOW_TERMS = {
  heresyBegetsRetribution: { detachment: 'Vow-sworn Crusaders', cp: 1, source: 'SECONDARY data/stratagems.json (Wahapedia 11e BT page, retrieved 2026-10-15)',
    when: 'Your opponent\u2019s Movement phase, when an enemy unit ends a move within 8" of a friendly ADEPTUS ASTARTES INFANTRY unit.', effect: 'Your unit can make a surge move of up to D6".' },
  purgeAndSanctify: { detachment: 'Fist of the God-Emperor', source: 'BSData catalog.json (Fist of the God-Emperor, rule "New Rule"); same text in Wahapedia snapshot bt.html.txt "Purge and Sanctify"',
    text: 'Each time a friendly Crusader Squad unit makes a surge move, instead of selecting a surge target, you can select the closest objective to that unit. When that unit makes that surge move, each model in that unit must end that surge move as close as possible to that objective instead.' },
  upholdTheHonour: { detachment: 'Vow-sworn Crusaders (Templar Vow, one Vow per battle)', source: 'Wahapedia snapshot /workspace/codex-rebuild/bt.html.txt:2815 (11e, Vow-sworn Crusaders > Templar Vows); BSData catalog.json Templar Vows carries an older wording (bsdataText)',
    text: 'Friendly INFANTRY units have: At the end of your Movement phase, if this unit is controlling an objective, that objective is secured. When this unit is selected to make an advance move, that advance move does not prevent this unit from being eligible to start an action.',
    bsdataText: "At the end of your Command phase, if this unit is within range of an objective marker you control, that objective marker remains under your control until your opponent's level of control over that objective marker is greater than yours at the end of the phase." },
  angelsDefiant: { detachment: 'Fist of the God-Emperor', cp: 1, source: 'SECONDARY data/stratagems.json (Wahapedia 11e BT page, retrieved 2026-10-15)',
    when: 'Your opponent\u2019s Shooting phase or the Fight phase, when an enemy unit targets a friendly CRUSADER SQUAD unit.', effect: 'Attacks that target your unit with a S greater than your unit\u2019s T have -1 to wound rolls.' },
  avowedDestruction: { detachment: 'Fist of the God-Emperor', cp: 1, source: 'SECONDARY data/stratagems.json (Wahapedia 11e BT page, retrieved 2026-10-15)',
    when: 'The Fight phase, when a friendly CRUSADER SQUAD unit is selected to fight.', effect: 'Your unit\u2019s melee attacks: Have [LETHAL HITS]. Or: Have [SUSTAINED HITS 1].' },
} as const;

/** Detachment RULE effects: attacker-side and defender-side ability ids (src/engine/strats.ts ABILITIES). */
export const RULE_EFFECTS: Record<string, { rule: string; attack: string[]; defence: string[]; gap?: string }> = {
  'Fist of the God-Emperor': { rule: 'New Rule (Crusader Squad surge to objective)', attack: [], defence: [], gap: 'movement only (surge toward the closest objective): no dice effect' },
  'Gravis Linebreaker Force': { rule: 'Walking Fortress', attack: ['walking-fortress'], defence: [] },
  'Gravis Siege Force': { rule: 'Indomitable Defence', attack: [], defence: ['indomitable-defence'] },
  'Gladius Task Force': { rule: 'Codex Discipline', attack: [], defence: [], gap: 'one extra Combat Doctrine use; BSData doctrines are movement-only (Advance+charge, Assault weapons, Fall Back+shoot), no dice effect' },
  'Assault Brethren': { rule: 'Assault Mastery', attack: [], defence: [], gap: 'one extra assault doctrine use: movement only; it only matters through Gene-wrought Might / Laurels assault variants, which are not applied' },
  'Tacticus Attack Force': { rule: 'Wrath of the Chapter', attack: [], defence: [], gap: 're-roll Advance rolls: movement only' },
};

/** Enhancement effects (BSData text). attack/defence = ability ids; weapon = bearer-model weapon change; pregame/ocPerModel feed list terms. */
export const ENHANCEMENT_EFFECTS: Record<string, { attack?: string[]; defence?: string[]; weapon?: { meleeS: number; meleeAP: number }; pregame?: boolean; ocPerModel?: number; gap?: string }> = {
  'Incendiary Animus': { attack: ['incendiary-animus'] },
  'Laurels of Triumph': { weapon: { meleeS: 1, meleeAP: 1 }, gap: 'assault-doctrine variant (+2 S and AP) not applied: doctrine uses are limited per battle' },
  'Furious Assault (Upgrade)': { attack: ['furious-assault'] },
  'Indefatigable Fortitude': { defence: ['indefatigable-fortitude'] },
  'Relentless Advance': { pregame: true },
  'Spearpoint War Leader': { pregame: true },
  'Zealous Vanguard': { pregame: true },
  'Immovable Conquerors (Upgrade)': { ocPerModel: 1 },
  'Standard of the Emperor Ascendant': { ocPerModel: 1, gap: 'Feel No Pain 5+ on the bearer model and once-per-battle +1 A are not modelled (bearer-only FNP in a mixed unit; once-per-battle)' },
  'Artificer Armour': { gap: '2+ Sv and FNP 5+ on the bearer model only: the defender model groups do not carry per-character saves for an attached bearer' },
  'Martial Paragon': { gap: 're-roll ONE hit roll and ONE wound roll per activation: the engine has no single-die re-roll' },
  'Adept of the Codex': { gap: 'tactical doctrine (Fall Back and shoot/charge): movement only' },
  'Narthecis Gauntlet': { gap: 'healing D3+1 in the Command phase: multi-turn, not one activation' },
  'Oathbound Exemplar': { gap: 'action eligibility after advance/fall back: not dice' },
  'Righteous Fervour (Upgrade)': { gap: 're-roll Advance rolls: movement only' },
  "Imperium's Sword": { gap: 'BSData text is EMPTY at d506fcc: effect unknown, not invented' },
};

/** Stratagems sourced (SECONDARY) but not modelled in a single offensive activation. */
export const STRATAGEM_GAPS: Record<string, string> = {
  'ARMOUR OF CONTEMPT': 'defensive CP spend (-1 AP to incoming): optimizer does not spend enemy-turn CP; not applied to points-at-risk',
  'ANGELS DEFIANT': 'defensive CP spend: modelled in matchup (angels-defiant) and, since 2026-10-15, in optimizer points-at-risk for blocks containing a CRUSADER SQUAD (applied to every enemy activation; CP budget not tracked)',
  'A WORTHY DEATH': 'fight-on-death 4+: needs fight sequencing', 'DUTY IN DEATH': 'fight-on-death 4+: needs fight sequencing',
  'STORM OF DEVASTATION': '[IGNORES COVER]: optimizer activations assume no cover, so no change', 'ADAPTIVE STRATEGY': 'doctrine: movement only', 'DOCTRINAL FLEXIBILITY': 'doctrine: movement only',
  'RESPONSIVE TACTICS': 'movement', 'TRANSHUMAN SWIFTNESS': 'fights first: sequencing', 'TACTICAL FOCUS': 'movement', 'PURGATION PUSH': 'movement',
  'ARMOURED IMPACT': 'mortal wounds on charge (D6 per engaged model, 3+): engine has no mortal-wound source yet', 'STAND UNYIELDING': 'objective secured: mission, not dice', 'SUPPRESSION VOLLEYS': 'battle-shock: not dice damage',
};

const enhOf = (u: RosterUnit) => (u.enhancement ? ENHANCEMENT_EFFECTS[Object.keys(ENHANCEMENT_EFFECTS).find((k) => n(k) === n(u.enhancement!) || n(k).startsWith(n(u.enhancement!))) ?? ''] : undefined);
export function attackAbilities(detachments: string[], units: RosterUnit[]): string[] {
  return [...new Set([...detachments.flatMap((d) => RULE_EFFECTS[d]?.attack ?? []), ...units.flatMap((u) => enhOf(u)?.attack ?? [])])];
}
export function defenceAbilities(detachments: string[], units: RosterUnit[]): string[] {
  return [...new Set([...detachments.flatMap((d) => RULE_EFFECTS[d]?.defence ?? []), ...units.flatMap((u) => enhOf(u)?.defence ?? [])])];
}
export function enhancementEffect(name: string | null | undefined) { return name ? enhOf({ enhancement: name } as RosterUnit) : undefined; }
/** True when an enhancement changes engine output (so blocks with it need their own exact cells). */
export const diceEnhancement = (name: string) => { const e = enhancementEffect(name); return !!e && !!(e.attack?.length || e.defence?.length || e.weapon); };
