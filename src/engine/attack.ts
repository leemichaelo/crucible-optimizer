/**
 * Exact attack-sequence engine. Produces full kill and damage distributions by propagating a probability
 * distribution over defender states (alive models per group + damage on the wounded model) hit by hit.
 */
import { diceDist, mean, convolve, point, shift, type Dist } from './dice.ts';
import type { Defender, EngineWeapon, Modifiers, Reroll, SequenceResult } from './types.ts';

interface Face { fail: number; hit: number; crit: number; }

/** One D6 roll with target `need` (after modifiers), crit on unmodified >= critOn, optional reroll. Unmodified 1 always fails. */
export function rollFace(need: number, critOn: number, reroll: Reroll): Face {
  const one = (): Face => {
    let fail = 0; let hit = 0; let crit = 0;
    for (let f = 1; f <= 6; f++) {
      if (f === 1) { fail++; continue; }
      if (f >= critOn) { crit++; continue; }
      if (f === 6 || f >= need) hit++; else fail++;
    }
    return { fail: fail / 6, hit: hit / 6, crit: crit / 6 };
  };
  const base = one();
  if (reroll === 'none') return base;
  const rr = reroll === 'all' ? base.fail : 1 / 6; // reroll ones: face 1 only
  return { fail: base.fail - rr + rr * base.fail, hit: base.hit + rr * base.hit, crit: base.crit + rr * base.crit };
}

export function woundNeed(S: number, T: number): number {
  if (S >= 2 * T) return 2;
  if (S > T) return 3;
  if (S === T) return 4;
  if (S * 2 <= T) return 6;
  return 5;
}

/** Move probability of values below 1 up to 1 (characteristic floor). */
function floorAt1(d: Dist): Dist { const o = d.slice(); let p = 0; for (let v = 0; v < 1 && v < o.length; v++) { p += o[v]!; o[v] = 0; } if (o.length < 2) o.length = 2; o[1] = (o[1] ?? 0) + p; return o.map((x) => x ?? 0); }

const clamp = (v: number, cap: boolean) => (cap ? Math.max(-1, Math.min(1, v)) : v);

/** P(save succeeds) for a group, 11e 05.03: InSv compared unmodified; armour after AP. Unmodified 1 fails. */
export function pSave(Sv: number, InSv: number | null, AP: number, saveMod = 0): number {
  // Sv/InSv cannot be better than 2+; AP cannot be worsened past 0; InSv ignores AP; no cap on save modifiers;
  // unmodified 1 always fails; no automatic save on a 6.
  const sv = Math.max(2, Sv); const inv = InSv === null ? null : Math.max(2, InSv);
  const ap = Math.min(0, AP);
  let best = 0;
  let a = 0; let i = 0;
  for (let f = 2; f <= 6; f++) {
    if (f + ap + saveMod >= sv) a++;
    if (inv !== null && f >= inv) i++;
  }
  best = Math.max(a, i) / 6;
  return best;
}

/** Damage after Feel No Pain: each point ignored independently on fnp+. */
export function fnpDist(d: Dist, fnp: number | null): Dist {
  if (fnp === null) return d;
  const pIgnore = Math.max(0, Math.min(1, (7 - fnp) / 6));
  let out: Dist = [0];
  d.forEach((p, v) => {
    if (!p) return;
    // binomial(v, 1-pIgnore)
    let b: Dist = [1];
    for (let k = 0; k < v; k++) b = convolve(b, [pIgnore, 1 - pIgnore]);
    const scaled = b.map((x) => x * p);
    out = add(out, scaled);
  });
  return out;
}

function add(a: Dist, b: Dist): Dist {
  const out = new Array(Math.max(a.length, b.length)).fill(0);
  a.forEach((p, i) => (out[i] += p));
  b.forEach((p, i) => (out[i] += p));
  return out;
}

/** Defender state: alive per group, wounded group index (-1 none), damage on wounded model. */
type State = string; // `${alive.join(',')}|${wg}|${dmg}`
const enc = (alive: number[], wg: number, dmg: number): State => `${alive.join(',')}|${wg}|${dmg}`;
function dec(s: State): [number[], number, number] {
  const [a, w, d] = s.split('|');
  return [a!.split(',').map(Number), Number(w), Number(d)];
}

interface Resolved {
  w: EngineWeapon;
  hit: Face;
  sustained: Dist; // extra hits per crit
  lethal: boolean;
  wound: Face;
  dev: boolean;
  precision: boolean;
  AP: number;
  dmg: Dist;
  attacksPerCopy: Dist;
  saveMod: number;
}

export function resolveWeapon(w: EngineWeapon, def: Defender, mods: Modifiers, notes: Set<string>): Resolved {
  const melee = w.type === 'melee';
  const m = melee ? { ...mods, ...mods.meleeOnly } : { ...mods, ...(mods.rangedOnly ?? {}) };
  const S = Math.max(1, w.S + m.strengthBonus); // characteristic floor S >= 1
  // hit
  let hitMod = m.hitMod + (w.heavy && m.stationary && !melee ? 1 : 0);
  if (m.cover && !melee && !w.ignoresCover) { hitMod -= 1; notes.add('cover: 11e 13.08 worsens ranged BS by 1 (modelled as -1 to hit)'); }
  if (m.ignoreHitMods) hitMod = Math.max(0, hitMod);
  hitMod = clamp(hitMod, m.capModifiers);
  const lethal = !!(w.lethalHits || m.lethalHits);
  // Sustained Hits never stacks (e.g. Furious Assault on a unit whose weapon already has Sustained Hits from Terminatus Assault): use the better single value.
  const susOpts = [m.sustainedHits, w.sustainedHits].filter((x) => !!x) as (number | string)[];
  const sus = susOpts.length ? susOpts.reduce((a, b) => (mean(diceDist(b)) > mean(diceDist(a)) ? b : a)) : 0;
  const hit: Face = w.torrent || w.skill === null ? { fail: 0, hit: 1, crit: 0 } : rollFace(Math.min(6, Math.max(2, (w.skill ?? 7) - hitMod)), 6, m.rerollHits); // WS/BS clamped 2+..6+; unmodified 1 fails, 6 crits
  // wound
  let wMod = m.woundMod + (w.lance && m.charged && melee ? 1 : 0);
  if (m.minusOneWoundIfSgtT && S > def.T) wMod -= 1;
  if (m.plusOneWoundIfTgtS && def.T > S) wMod += 1;
  wMod = clamp(wMod, m.capModifiers);
  let critW = 6;
  for (const [kw, n] of w.anti ?? []) if (kw.split('/').some((k) => def.keywords.includes(k.trim()))) critW = Math.min(critW, n);
  const wound = rollFace(woundNeed(S, def.T) - wMod, critW, w.twinLinked ? 'all' : m.rerollWounds);
  let dmg = diceDist(w.D);
  if (w.melta && m.halfRange && !melee) dmg = shift(dmg, w.melta);
  if (m.damageMod) dmg = floorAt1(shift(dmg, m.damageMod)); // D >= 1
  let attacks = diceDist(w.A);
  if (m.attacksBonus) attacks = floorAt1(shift(attacks, m.attacksBonus)); // A >= 1
  if (w.rapidFire && m.halfRange && !melee) attacks = convolve(attacks, diceDist(w.rapidFire));
  if (w.blast) {
    const models = def.groups.reduce((s, g) => s + g.count, 0);
    attacks = shift(attacks, w.blast * Math.floor(models / 5));
  }
  return {
    w, hit, sustained: diceDist(sus), lethal, wound, dev: !!(w.devastatingWounds || m.devastatingWounds),
    precision: !!(w.precision || m.precision), AP: Math.min(0, w.AP + m.apBonus), dmg, attacksPerCopy: attacks, saveMod: m.saveMod,
  };
}

/** Pick the model a packet is allocated to. Returns group index or -1 if unit destroyed. */
function target(def: Defender, alive: number[], wg: number, precision: boolean): number {
  const chars = def.groups.map((g, i) => (g.character && alive[i]! > 0 ? i : -1)).filter((i) => i >= 0);
  if (precision && chars.length) {
    if (wg >= 0 && def.groups[wg]!.character) return wg;
    return chars[0]!;
  }
  if (wg >= 0) return wg;
  // non-character groups first (in listed order), then characters
  for (let i = 0; i < def.groups.length; i++) if (!def.groups[i]!.character && alive[i]! > 0) return i;
  for (let i = 0; i < def.groups.length; i++) if (alive[i]! > 0) return i;
  return -1;
}

/** Apply one damage packet (already post-FNP) to a state. */
function applyDamage(def: Defender, alive: number[], wg: number, dmg: number, g: number, amount: number): State {
  if (amount <= 0) return enc(alive, wg, dmg);
  const cur = g === wg ? dmg : 0;
  const W = def.groups[g]!.W;
  if (cur + amount >= W) {
    const a = alive.slice(); a[g]!--;
    return enc(a, -1, 0);
  }
  return enc(alive, g, cur + amount);
}

type SD = Map<State, number>;
function addTo(m: SD, s: State, p: number) { if (p > 0) m.set(s, (m.get(s) ?? 0) + p); }

/** Transition for one wound that must be saved (or a mortal packet if `mortal`). */
function woundStep(def: Defender, r: Resolved, sd: SD, mortal: boolean, dmgCache: Map<number, Dist>): SD {
  const out: SD = new Map();
  for (const [s, p] of sd) {
    const [alive, wg, dmg] = dec(s);
    const g = target(def, alive, wg, r.precision);
    if (g < 0) { addTo(out, s, p); continue; }
    const grp = def.groups[g]!;
    const pFail = mortal ? 1 : 1 - pSave(grp.Sv, grp.InSv, r.AP, r.saveMod);
    addTo(out, s, p * (1 - pFail));
    let dd = dmgCache.get(g);
    if (!dd) { dd = fnpDist(r.dmg, grp.fnp); dmgCache.set(g, dd); }
    dd.forEach((q, amount) => { if (q) addTo(out, applyDamage(def, alive, wg, dmg, g, amount), p * pFail * q); });
  }
  return out;
}

/** Transition for one hit (normal: roll to wound; auto: lethal auto-wound). */
function hitStep(def: Defender, r: Resolved, sd: SD, auto: boolean, cache: Map<number, Dist>): SD {
  if (auto) return woundStep(def, r, sd, false, cache);
  const out: SD = new Map();
  const { fail, hit, crit } = r.wound;
  for (const [s, p] of sd) addTo(out, s, p * fail);
  const normalP = hit + (r.dev ? 0 : crit);
  if (normalP > 0) for (const [s, p] of woundStep(def, r, scale(sd, normalP), false, cache)) addTo(out, s, p);
  if (r.dev && crit > 0) for (const [s, p] of woundStep(def, r, scale(sd, crit), true, cache)) addTo(out, s, p);
  return out;
}

function scale(sd: SD, k: number): SD { const o: SD = new Map(); for (const [s, p] of sd) o.set(s, p * k); return o; }
function mix(a: SD, b: SD): SD { const o: SD = new Map(a); for (const [s, p] of b) addTo(o, s, p); return o; }

/** Transition for one attack die. */
function attackStep(def: Defender, r: Resolved, sd: SD, cache: Map<number, Dist>): SD {
  const { fail, hit, crit } = r.hit;
  let out = scale(sd, fail);
  if (hit > 0) out = mix(out, hitStep(def, r, scale(sd, hit), false, cache));
  if (crit > 0) {
    let c = hitStep(def, r, scale(sd, crit), r.lethal, cache);
    // sustained extra hits (normal hits)
    if (r.sustained.length > 1) {
      let acc: SD = scale(c, r.sustained[0] ?? 0);
      let cur = c;
      for (let k = 1; k < r.sustained.length; k++) {
        cur = hitStep(def, r, cur, false, cache);
        acc = mix(acc, scale(cur, r.sustained[k] ?? 0));
      }
      c = acc;
    }
    out = mix(out, c);
  }
  return out;
}

export function initialState(def: Defender): State { return enc(def.groups.map((g) => g.count), -1, 0); }

/** Run a full attack sequence (weapons in order) and return exact distributions. */
export function runSequence(weapons: EngineWeapon[], def: Defender, mods: Modifiers): SequenceResult {
  const notes = new Set<string>();
  if (mods.capModifiers) notes.add('SOURCED: net hit and wound modifiers capped at +/-1 (App Rules Commentary 02.02.01)');
  notes.add('allocation: wounded model first, non-CHARACTER groups before CHARACTER groups; Precision targets CHARACTER groups first');
  notes.add('Devastating Wounds: crit wound becomes mortal damage = D, max one model per crit (11e 24.10), FNP applies');
  let sd: SD = new Map([[initialState(def), 1]]);
  const perWeaponEV: SequenceResult['perWeaponEV'] = [];
  for (const w of weapons) {
    const r = resolveWeapon(w, def, mods, notes);
    const total: Dist = (() => { let d: Dist = [1]; for (let i = 0; i < w.copies; i++) d = convolve(d, r.attacksPerCopy); return d; })();
    // closed-form EV vs first group (no overkill)
    const g0 = def.groups.find((g) => !g.character) ?? def.groups[0]!;
    const A = mean(total);
    const susN = mean(r.sustained);
    const hits = A * (r.hit.hit + r.hit.crit * (1 + susN));
    const autoW = r.lethal ? A * r.hit.crit : 0;
    const rolledHits = hits - autoW;
    const devW = r.dev ? rolledHits * r.wound.crit : 0;
    const normW = rolledHits * (r.wound.hit + (r.dev ? 0 : r.wound.crit)) + autoW;
    const unsaved = normW * (1 - pSave(g0.Sv, g0.InSv, r.AP, r.saveMod)) + devW;
    perWeaponEV.push({ name: w.name, hits, wounds: normW + devW, unsaved, damage: unsaved * mean(fnpDist(r.dmg, g0.fnp)) });
    // sequential propagation with mixture over attack count
    const cache = new Map<number, Dist>();
    let acc: SD = new Map();
    let cur = sd;
    for (let k = 0; k < total.length; k++) {
      if (k > 0) cur = attackStep(def, r, cur, cache);
      const pk = total[k] ?? 0;
      if (pk > 0) acc = mix(acc, scale(cur, pk));
    }
    sd = acc;
  }
  return summarize(def, sd, perWeaponEV, [...notes]);
}

function summarize(def: Defender, sd: SD, perWeaponEV: SequenceResult['perWeaponEV'], assumptions: string[]): SequenceResult {
  const totalModels = def.groups.reduce((s, g) => s + g.count, 0);
  const totalW = def.groups.reduce((s, g) => s + g.count * g.W, 0);
  const killDist = new Array(totalModels + 1).fill(0);
  const damageDist = new Array(totalW + 1).fill(0);
  const groupKillDists: Record<string, number[]> = {};
  const gk = (i: number) => `${i + 1}. ${def.groups[i]!.name}`;
  def.groups.forEach((g, i) => (groupKillDists[gk(i)] = new Array(g.count + 1).fill(0)));
  for (const [s, p] of sd) {
    const [alive, wg, dmg] = dec(s);
    let kills = 0; let dealt = 0;
    def.groups.forEach((g, i) => { const k = g.count - alive[i]!; kills += k; dealt += k * g.W; const arr = groupKillDists[gk(i)]!; arr[k] = (arr[k] ?? 0) + p; });
    if (wg >= 0) dealt += dmg;
    killDist[kills] += p; damageDist[dealt] += p;
  }
  return {
    killDist, damageDist, groupKillDists, expectedKills: mean(killDist), expectedDamage: mean(damageDist),
    pWipe: killDist[totalModels] ?? 0, perWeaponEV, assumptions,
  };
}

export { point };

/** Closed-form expected damage (pre-overkill, vs the first non-character group). Cheap proxy used for pruning. */
export function quickEV(weapons: EngineWeapon[], def: Defender, mods: Modifiers): number {
  const notes = new Set<string>();
  let total = 0;
  const g0 = def.groups.find((g) => !g.character) ?? def.groups[0]!;
  for (const w of weapons) {
    const r = resolveWeapon(w, def, mods, notes);
    const A = mean(r.attacksPerCopy) * w.copies;
    const hits = A * (r.hit.hit + r.hit.crit * (1 + mean(r.sustained)));
    const autoW = r.lethal ? A * r.hit.crit : 0;
    const rolled = hits - autoW;
    const devW = r.dev ? rolled * r.wound.crit : 0;
    const normW = rolled * (r.wound.hit + (r.dev ? 0 : r.wound.crit)) + autoW;
    total += (normW * (1 - pSave(g0.Sv, g0.InSv, r.AP, r.saveMod)) + devW) * mean(fnpDist(r.dmg, g0.fnp));
  }
  return total;
}
