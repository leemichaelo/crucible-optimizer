import { dispositionMedians, missionKey, type Disposition } from '../select/selectionCore.ts';
/** Per-block, per-opponent-unit exact scoring and the list-level objective. */
import type { CatalogIndex } from '../catalog/core.ts';
import { norm } from '../bsdata/parse.ts';
import type { RosterUnit } from '../roster/types.ts';
import { runSequence, quickEV, pSave, woundNeed, rollFace } from '../engine/attack.ts';
import { applyConditional, toEngineWeapon, weaponSlots, type BuildNotes } from '../engine/build.ts';
import { STRATS, findRule, type StratContext } from '../engine/strats.ts';
import { NO_MODS, type Defender, type EngineWeapon, type Modifiers } from '../engine/types.ts';
import { bestModel } from '../validate/validator.ts';
import { enhancementEffect } from '../rules/detachments.ts';

export interface OppUnit { id: string; list: string; label: string; pts: number; def: Defender; models: number;
  /** Opponent unit as an ATTACKER (for points-at-risk: enemy activations into our blocks). Absent for reference units. */
  attacker?: { units: RosterUnit[]; scope: string[]; faction: string };
}
export interface Cell { pKill: number; ptsRemoved: number; expDamage: number; strat: string | null; }

/** Default offensive strat set (Fist of the God-Emperor + Vow-sworn Crusaders, the fixture lists' detachments). Use offensiveStratsFor(detachments) for anything else. */
export const OFFENSIVE_STRATS = ['avowed-destruction:lethal', 'avowed-destruction:sustained', 'for-the-emperors-honour', 'pious-enmity', 'pious-enmity:monster-vehicle'];

export type Phase = 'ranged' | 'melee';
export const BOTH_PHASES: readonly Phase[] = ['ranged', 'melee'];

/**
 * BSData "Terminatus Assault" (Terminator Assault Squad): "If this unit made a charge move this turn, this unit's: Lightning Claws weapons have
 * [SUSTAINED HITS 1: NON-MONSTER/VEHICLE]; Thunder Hammer weapons have [SUSTAINED HITS 1: MONSTER/VEHICLE]". Parsed from the ability text, so any datasheet
 * carrying the same wording gets it. Returns the Sustained Hits value for this melee weapon vs this defender, or 0.
 */
export function chargeSustained(abilities: { name: string; text: string }[], weaponName: string, defKeywords: string[], charged: boolean): number {
  if (!charged) return 0;
  let best = 0;
  for (const a of abilities) {
    if (!/charge move/i.test(a.text)) continue;
    for (const m of a.text.matchAll(/([A-Za-z' -]+?) weapons have \[SUSTAINED HITS (\d+): (NON-)?([A-Z/ ]+)\]/gi)) {
      const wn = m[1]!.trim().toLowerCase().replace(/s$/, '');
      if (!weaponName.toLowerCase().includes(wn)) continue;
      const kws = m[4]!.split('/').map((k) => k.trim().toLowerCase());
      const hit = kws.some((k) => defKeywords.includes(k));
      if (m[3] ? !hit : hit) best = Math.max(best, Number(m[2]));
    }
  }
  return best;
}

export function attackWeapons(cat: CatalogIndex, scope: string[], group: RosterUnit[], def: Defender, notes: BuildNotes, mods: Modifiers, phases: readonly Phase[] = BOTH_PHASES): EngineWeapon[] {
  const out: EngineWeapon[] = [];
  for (const u of group) {
    const e = cat.findUnit(u.name, scope);
    if (!e) continue;
    for (const slot of weaponSlots(u, e, notes)) {
      for (const phase of phases) {
        const profs = slot.profiles.filter((p) => p.type === phase);
        if (!profs.length || slot.copies <= 0) continue;
        let best: EngineWeapon | null = null; let bestEv = -1;
        for (const p of profs) {
          const w0 = toEngineWeapon(p, slot.copies);
          if (!w0) continue;
          const w = applyConditional(w0, p, def.keywords);
          const ev = profs.length > 1 ? quickEV([w], def, mods) : 0;
          if (ev > bestEv) { bestEv = ev; best = w; }
        }
        if (best && phase === 'melee') { const cs = chargeSustained(e.abilities, best.name, def.keywords, !!mods.charged); if (cs && !(typeof best.sustainedHits === 'number' && best.sustainedHits >= cs)) { best = { ...best, sustainedHits: typeof best.sustainedHits === 'string' ? best.sustainedHits : cs }; notes.heuristics.push(`${e.name}: charge-conditional [SUSTAINED HITS ${cs}] on ${best.name} (BSData ability text, charged activation)`); } }
        if (best && phase === 'melee') { const w = enhancementEffect(u.enhancement)?.weapon; if (w && u.attachedAs !== 'Bodyguard') best = { ...best, S: best.S + w.meleeS, AP: best.AP - w.meleeAP, name: `${best.name} (+${w.meleeS}S/+${w.meleeAP}AP ${u.enhancement})` }; }
        if (best) out.push(best);
      }
    }
  }
  return out;
}

export function ctxFor(cat: CatalogIndex, scope: string[], group: RosterUnit[], def: Defender): StratContext {
  const ents = group.map((u) => cat.findUnit(u.name, scope));
  return {
    attackerKeywords: [...new Set(ents.flatMap((e) => (e ? [...e.keywords, ...e.factionKeywords] : []).map((k) => k.toLowerCase())))],
    attackerUnits: group.map((u) => norm(u.name)), defenderKeywords: def.keywords, defenderUnits: [norm(def.name)],
  };
}

/** One activation = all ranged weapons then all melee weapons (charged) into a full-strength target, best eligible strat. */
export function scoreCell(cat: CatalogIndex, scope: string[], group: RosterUnit[], opp: OppUnit, notes: BuildNotes, autoAbilities: string[], strats: string[] = OFFENSIVE_STRATS, phases: readonly Phase[] = BOTH_PHASES): Cell {
  const base: Modifiers = { ...NO_MODS, meleeOnly: {}, charged: true };
  const ctx = ctxFor(cat, scope, group, opp.def);
  for (const a of autoAbilities) findRule(a)?.apply(base, ctx);
  const weapons = attackWeapons(cat, scope, group, opp.def, notes, base, phases);
  let best: Cell = { pKill: -1, ptsRemoved: -1, expDamage: 0, strat: null };
  for (const sid of [null, ...strats]) {
    const m: Modifiers = { ...base, meleeOnly: { ...base.meleeOnly } };
    if (sid) { const r = STRATS.find((s) => s.id === sid)!.apply(m, ctx); if (!r.ok) continue; }
    const res = runSequence(weapons, opp.def, m);
    const c: Cell = { pKill: res.pWipe, ptsRemoved: (res.expectedKills / opp.models) * opp.pts, expDamage: res.expectedDamage, strat: sid };
    if (c.pKill > best.pKill + 1e-9 || (Math.abs(c.pKill - best.pKill) <= 1e-9 && c.ptsRemoved > best.ptsRemoved)) best = c;
  }
  return best;
}

export function proxyScore(cat: CatalogIndex, scope: string[], group: RosterUnit[], opps: OppUnit[], notes: BuildNotes): number {
  const m: Modifiers = { ...NO_MODS, meleeOnly: {}, charged: true };
  let s = 0;
  for (const o of opps) {
    const w = attackWeapons(cat, scope, group, o.def, notes, m);
    const totalW = o.def.groups.reduce((a, g) => a + g.count * g.W, 0);
    s += Math.min(1, quickEV(w, o.def, m) / totalW) * o.pts;
  }
  return s;
}

/** Take and Hold heuristic features of a list (all HEURISTIC, see WEIGHTS). */
export interface THFeatures { oc: number; effectiveWounds: number; actionUnits: number; }

export function thFeatures(cat: CatalogIndex, scope: string[], units: { u: RosterUnit; attached: boolean; pts: number }[]): THFeatures {
  let oc = 0; let eff = 0; let action = 0;
  for (const { u, attached, pts } of units) {
    const e = cat.findUnit(u.name, scope);
    if (!e) continue;
    const lines = u.models.length ? u.models : [{ name: e.name, count: u.modelCount, wargear: [] }];
    for (const m of lines) {
      const pn = bestModel(m.name, e.profiles.map((p) => p.name)) ?? e.profiles[0]!.name;
      const p = e.profiles.find((x) => x.name === pn)!;
      const ocv = Number.parseInt(p.OC, 10);
      oc += (Number.isFinite(ocv) ? ocv : 0) * m.count;
      if (p.T !== null && p.W !== null && p.Sv !== null) {
        // effective wounds vs a reference S5 AP-1 D1 attack (HEURISTIC reference profile)
        const f = rollFace(woundNeed(5, p.T), 6, 'none');
        const pUnsaved = (f.hit + f.crit) * (1 - pSave(p.Sv, p.InSv, -1));
        eff += (p.W * m.count) / Math.max(pUnsaved, 1e-6);
      }
    }
    // enhancement OC (BSData): "(Upgrade)" = whole unit, +1 per model; otherwise the bearer model only, +1
    const ocb = enhancementEffect(u.enhancement)?.ocPerModel ?? 0;
    if (ocb) oc += /\(upgrade\)/i.test(u.enhancement ?? '') ? ocb * lines.reduce((a, m) => a + m.count, 0) : ocb;
    const vehicle = e.keywords.some((k) => /^(vehicle|monster)$/i.test(k));
    if (!attached && pts <= 100 && !vehicle) action++;
  }
  return { oc, effectiveWounds: eff, actionUnits: action };
}

/**
 * Take and Hold weights, REVISED 2026-10-15 (structure change, see explanation[0..5]). Base weights were set a priori;
 * the single free parameter LAMBDA (share of the absolute-output weight moved to cost-charged efficiency) was chosen by
 */
export const BASE_TH_WEIGHTS = { killCoverage: 0.12, pointsRemoved: 0.04, efficiency: 0.18, bandRedundancy: 0.10, unitCount: 0.08, tierSplit: 0.08, actionScreen: 0.05, oc: 0.04, pregame: 0.04, durability: 0.03, cp: 0.02, enhancements: 0.01, antiArmourUnits: 0.04, uncoveredProfiles: 0.04, concentration: 0.05, pointsAtRisk: 0.03, detachmentRules: 0.03, fragileVehicle: 0.02 };
export type PartKey = keyof typeof BASE_TH_WEIGHTS;
export const ABSOLUTE_OUTPUT_TERMS: PartKey[] = ['killCoverage', 'pointsRemoved', 'uncoveredProfiles'];
/** Structural weight family: actionScreen folded into tierSplit (guide Utility tier), LAMBDA of the absolute-output weight moved to efficiency. */
export function thWeights(lambda: number): Record<PartKey, number> {
  const w = { ...BASE_TH_WEIGHTS };
  w.tierSplit += w.actionScreen; w.actionScreen = 0;
  let pool = 0; for (const k of ABSOLUTE_OUTPUT_TERMS) { pool += w[k] * lambda; w[k] *= 1 - lambda; }
  w.efficiency += pool;
  for (const k of Object.keys(w) as PartKey[]) w[k] = +w[k].toFixed(4);
  return w;
}
/** 0.8 and 0.9 tie on the core-7 fixtures; LOO picks 0.8 in every fold (ties resolve to the smaller shift). */
export const TH_LAMBDA = 0.8;
export const WEIGHTS = {
  ...thWeights(TH_LAMBDA),
  normalisers: { oc: 160, effectiveWounds: 1400, actionUnits: 4 },
  label: 'HEURISTIC Take and Hold weighting (author-chosen, not from any rules source)',
  explanation: [
    'killCoverage / pointsRemoved / uncoveredProfiles: kept but multiplied by (1 - LAMBDA) = 0.2; LAMBDA 0.8 chosen by leave-one-out over a 0..1 grid (every core-7 fold chose 0.8).',
    'actionScreen: weight folded into tierSplit (guide "6 Utility under 115 pts" already counts cheap units; the old term counted them twice). Part still reported.',
    'Rebalance: the 0.10 for the two new terms came from killCoverage -0.05 and pointsRemoved -0.02 (they overlap with uncoveredProfiles), bandRedundancy -0.02 (overlaps anti-armour), cp -0.01. Chosen before checking the fixture order, not tuned to it.',
    'killCoverage (0.20): HEURISTIC assignment. Each of our blocks (unit plus attached characters) gets 3 activations, one per battle round 1-3. Activations go greedily to the (block, enemy unit) pair with the biggest marginal gain in expected enemy points destroyed. An enemy unit hit by several activations survives with prob = product of (1 - P(kill)) over them, so stacking more onto a unit that is already likely dead earns little. Result = expected enemy points destroyed / enemy points, averaged over opponent lists. One deathstar can kill at most 3 targets, so several independent killers score higher. Per-cell P(kill) is the exact engine; the assignment is not optimal (greedy) and ignores movement, range, and enemy turns.',
    'pointsRemoved (0.10): same assignment; expected fraction of each enemy unit\'s points removed when it is not wiped (pts x fraction of models killed, HEURISTIC), combined over its assigned activations. A 0.25 weight on this partial damage also breaks ties in the greedy step.',
    'oc (0.07): total Objective Control on the table, divided by 160 and capped at 1. Take and Hold rewards holding objectives.',
    'durability (0.05): total effective wounds versus a reference S5 AP-1 D1 attack, divided by 1400 and capped at 1. Holding needs units that survive.',
    'tierSplit (0.10): HEURISTIC from list-guide.txt: "3 Heavies 200+ pts · 4 Workhorses 115–195 pts · 6 Utility under 115 pts"; Take and Hold median "3·4·4 (12)". Score = 1 - (|H-3|+|W-4|+|U-4|)/6, floor 0. An attached unit counts once at its combined points.',
    'bandRedundancy (0.15): HEURISTIC from list-guide.txt step 04: "At least two units for every toughness band: units that can remove 80+ points of a target in that band in one activation." Bands T3–4, T5, T6, T7–9, T10–11, T12+, one BSData reference each (Cadian Shock Troops x10, Intercessor Squad x5, Terminator Squad x5, Rhino, Leman Russ Battle Tank, Land Raider). A unit passes a band if exact-engine expected points removed >= 80 (or >= 80% of the reference when it costs under 100). Score = bands with 2+ passing units / 6.',
    'pregame (0.05): HEURISTIC (Tactician note, not in list-guide.txt): units with a pre-game move, read from BSData abilities/keywords Scouts or Infiltrators, or carrying Zealous Vanguard (BSData text: "This unit has Scouts 6\""). 2 such units = 1.',
    'enhancements (0.02): enhancements taken / 4 slots (BSData limits per enhancement, Lee: max one per attached unit). Only Incendiary Animus changes engine output; this term values the rest.',
    'cp (0.03): CP gained per battle round from the warlord. Helbrecht as warlord = 1 (BSData Transhuman Strategist), otherwise 0.',
    'Hard constraints (not weights): >= 2 tank killers (threshold 0.45) excluding Ballistus, >= 11 units (see tankKillerDefinition), every --lock satisfied, pure Support characters always attached.',
    'detachmentRules (0.03): NEW 2026-10-15, HEURISTIC. Mean of three sourced-rule terms (rules text quoted in FIST_VOW_TERMS, src/rules/detachments.ts): Heresy Begets Retribution 0.5 x min(1, ADEPTUS ASTARTES INFANTRY blocks/4) (Vow-sworn); Purge and Sanctify min(1, best Crusader Squad OC/20) (needs Fist AND Vow-sworn: HBR is the only sourced surge trigger); Uphold the Honour INFANTRY OC / list OC (Vow-sworn). 0 for other detachments (Gladius extra doctrine etc. are movement gaps, not scored).',
    'fragileVehicle (0.02): NEW 2026-10-15, HEURISTIC (Tactician #2: SCOUT-FIST Repulsor Executioner is a hide-first peak target). VEHICLE/MONSTER blocks >= 200 pts; exposure = share of opponent lists with one activation removing >= 50% of its points; 1 - sum(pts share x exposure)/0.10.',
    'Angels Defiant (Fist): -1 to wound vs S>T applied inside pointsAtRisk to blocks containing a CRUSADER SQUAD (HEURISTIC: CP assumed available for the worst activation).',
    'actionScreen (0.08): HEURISTIC (Tactician note, not in list-guide.txt) cheap action/screen units for secondaries: number of unattached non-vehicle units costing 100 pts or less (action/screening bodies), divided by 4 and capped at 1.',
    'One activation = all ranged weapons at full range, then all melee weapons having charged, into a full-strength target; best eligible offensive strat chosen per cell. No movement, range, line of sight, or opponent interaction is modelled.',
  ],
};

/** Purge the Foe weights: HEURISTIC (no rules source for weighting). Only the tier target 4·2·5 (12) is sourced (list-guide.txt step 01). */
export const PURGE_WEIGHTS = {
  ...WEIGHTS,
  killCoverage: 0.22, pointsRemoved: 0.08, efficiency: 0.10, bandRedundancy: 0.13, unitCount: 0.05, tierSplit: 0.10,
  actionScreen: 0.02, oc: 0.03, pregame: 0.02, durability: 0.05, cp: 0.02, enhancements: 0.01, antiArmourUnits: 0.08, uncoveredProfiles: 0.04, concentration: 0.02, pointsAtRisk: 0.03, detachmentRules: 0, fragileVehicle: 0,
  label: 'HEURISTIC Purge the Foe weighting (author-chosen; not from any rules source). Tier target 4·2·5 (12) quoted from list-guide.txt "PURGE THE FOE 4·2·5 (12)".',
  explanation: [...WEIGHTS.explanation.map((x) => x.replace(/^(\w+) \([0-9.]+\)/, '$1')), 'Purge weights (revised 2026-10-15, a priori, NOT calibrated: the calibration fixtures are Take and Hold lists): killCoverage 0.22, pointsRemoved 0.08, efficiency 0.10, concentration 0.02, pointsAtRisk 0.03, bandRedundancy 0.13, tierSplit 0.10 (target 4/2/5), antiArmourUnits 0.08, uncoveredProfiles 0.04, unitCount 0.05, durability 0.05, oc 0.03, actionScreen/pregame/cp 0.02, enhancements 0.01. Kill-focused because Purge the Foe rewards destroying units; weights themselves are not sourced.'],
};
/** Tier-shape medians per disposition, parsed from the list-guide quote (keys = optimizer mission keys). */
export const TIER_TARGETS: Record<string, [number, number, number]> = Object.fromEntries(Object.entries(dispositionMedians()).map(([d, t]) => [missionKey(d as Disposition), t]));
export function weightsFor(mission: string) { return mission === 'purge' ? PURGE_WEIGHTS : WEIGHTS; }
