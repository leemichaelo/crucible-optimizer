/** Builds engine inputs from parsed rosters + BSData catalog. Loadout choices that are not explicit are labelled heuristic. */
import type { CatalogIndex } from '../catalog/core.ts';
import { norm } from '../bsdata/parse.ts';
import type { RosterUnit, WargearLine } from '../roster/types.ts';
import type { UnitEntry, WeaponProfile } from '../types.ts';
import { bestModel } from '../validate/validator.ts';
import type { Defender, DefenderGroup, EngineWeapon } from './types.ts';

export interface BuildNotes { heuristics: string[]; warnings: string[]; }

export function toEngineWeapon(w: WeaponProfile, copies: number): EngineWeapon | null {
  const S = Number.parseInt(w.S, 10);
  if (!Number.isFinite(S)) return null;
  const e: EngineWeapon = { name: w.name, type: w.type, copies, A: w.A, skill: w.skill, S, AP: w.AP, D: w.D };
  for (const a of w.abilities) {
    if (a.condition) continue; // conditional abilities (e.g. "LETHAL HITS: non-MONSTER/VEHICLE") handled below
    switch (a.kind) {
      case 'lethal-hits': e.lethalHits = true; break;
      case 'sustained-hits': e.sustainedHits = a.dice ?? a.n ?? 0; break;
      case 'devastating-wounds': e.devastatingWounds = true; break;
      case 'twin-linked': e.twinLinked = true; break;
      case 'torrent': e.torrent = true; break;
      case 'precision': e.precision = true; break;
      case 'lance': e.lance = true; break;
      case 'heavy': e.heavy = true; break;
      case 'ignores-cover': e.ignoresCover = true; break;
      case 'blast': e.blast = a.n ?? 1; break;
      case 'cleave': e.blast = (e.blast ?? 0) + (a.n ?? 1); break; // 11e 24.06: +X attacks per 5 target models (single target)
      case 'melta': e.melta = a.n ?? 0; break;
      case 'rapid-fire': e.rapidFire = a.dice ?? a.n ?? 0; break;
      case 'anti': (e.anti ??= []).push([a.keyword ?? '', a.n ?? 6]); break;
    }
  }
  return e;
}

/** Apply conditional weapon abilities that depend on defender keywords. */
export function applyConditional(e: EngineWeapon, w: WeaponProfile, defKeywords: string[]): EngineWeapon {
  const out = { ...e };
  for (const a of w.abilities) {
    if (!a.condition) continue;
    const neg = a.condition.startsWith('non-');
    const kws = a.condition.replace(/^non-/, '').split('/').map((x) => x.trim().replace(/s$/, ''));
    const match = kws.some((k) => defKeywords.includes(k));
    if (neg ? match : !match) continue;
    if (a.kind === 'lethal-hits') out.lethalHits = true;
    if (a.kind === 'devastating-wounds') out.devastatingWounds = true;
    if (a.kind === 'sustained-hits') out.sustainedHits = a.dice ?? a.n ?? 0;
  }
  return out;
}

function weaponProfiles(entry: UnitEntry, item: string): WeaponProfile[] {
  const n = norm(item);
  return entry.weapons.filter((w) => norm(w.name.replace(/^➤\s*/, '').split(' - ')[0]!) === n || norm(w.name) === n);
}

export interface WeaponSlot { unit: string; model: string; profiles: WeaponProfile[]; copies: number; }

/** Resolve a roster unit's wargear into weapon slots, applying the loadout heuristics. */
export function weaponSlots(u: RosterUnit, entry: UnitEntry, notes: BuildNotes): WeaponSlot[] {
  const out: WeaponSlot[] = [];
  const lines: { model: string; count: number; gear: WargearLine[] }[] = u.models.length
    ? u.models.map((m) => ({ model: m.name, count: m.count, gear: m.wargear }))
    : [{ model: u.name, count: u.modelCount, gear: u.unitWargear }];
  if (u.models.length && u.unitWargear.length) lines[0]!.gear = [...lines[0]!.gear, ...u.unitWargear];
  for (const l of lines) {
    if (!l.gear.length && entry.minModels === 1 && entry.maxModels === 1) {
      // fixed-wargear character/vehicle: BSData lists weapons as profiles without selections
      const names = [...new Set(entry.weapons.map((w) => w.name.replace(/^➤\s*/, '').split(' - ')[0]!))];
      l.gear = names.map((n) => ({ name: n, count: l.count }));
      notes.heuristics.push(`${u.name}: no wargear listed; using every BSData weapon on the datasheet (${names.join(', ')})`);
    }
    const melee: WeaponSlot[] = []; const ranged: WeaponSlot[] = [];
    for (const g of l.gear) {
      const profs = weaponProfiles(entry, g.name);
      if (!profs.length) { notes.warnings.push(`${u.name}/${l.model}: "${g.name}" is not a BSData weapon (treated as non-weapon wargear)`); continue; }
      const m = profs.filter((p) => p.type === 'melee'); const r = profs.filter((p) => p.type === 'ranged');
      if (m.length) melee.push({ unit: u.name, model: l.model, profiles: m, copies: g.count });
      if (r.length) ranged.push({ unit: u.name, model: l.model, profiles: r, copies: g.count });
    }
    // melee: one melee weapon per model (+ Extra Attacks weapons). Generic CCW fills only models without a specific weapon.
    const extra = melee.filter((s) => s.profiles.some((p) => p.abilities.some((a) => a.kind === 'extra-attacks')));
    const main = melee.filter((s) => !extra.includes(s));
    const ccw = main.filter((s) => /^close combat weapon$/i.test(s.profiles[0]!.name));
    const specific = main.filter((s) => !ccw.includes(s));
    const specCount = specific.reduce((a, s) => a + s.copies, 0);
    if (ccw.length && specCount > 0) {
      const fill = Math.max(0, l.count - specCount);
      if (ccw[0]!.copies !== fill) notes.heuristics.push(`${u.name}/${l.model}: listed ${ccw[0]!.copies}x Close combat weapon; using ${fill} (models without a specific melee weapon)`);
      ccw[0]!.copies = fill;
    }
    out.push(...extra, ...specific, ...ccw.filter((s) => s.copies > 0));
    // ranged (11e 24.07): non-MONSTER/VEHICLE models use either their [CLOSE-QUARTERS] weapons or other ranged weapons in normal shooting.
    // HEURISTIC: close-quarters weapons fire only for models with no other ranged weapon; one CQ weapon per model, best by S/AP/D.
    const isPistol = (s: WeaponSlot) => s.profiles.some((p) => p.abilities.some((a) => a.kind === 'pistol' || a.kind === 'close-quarters'));
    const bigModel = entry.keywords.some((k) => /^(vehicle|monster)$/i.test(k));
    const pistols = bigModel ? [] : ranged.filter(isPistol); const guns = bigModel ? ranged : ranged.filter((s) => !isPistol(s));
    const gunCount = guns.reduce((a, s) => a + s.copies, 0);
    out.push(...guns);
    if (pistols.length) {
      const free = l.count > 1 ? Math.max(0, l.count - gunCount) : (gunCount ? 0 : 1);
      if (free > 0) {
        const best = [...pistols].sort((a, b) => score(b.profiles[0]!) - score(a.profiles[0]!))[0]!;
        const copies = Math.min(free, best.copies);
        if (pistols.length > 1 || copies !== best.copies) notes.heuristics.push(`${u.name}/${l.model}: pistols ${pistols.map((p) => `${p.copies}x ${p.profiles[0]!.name}`).join(', ')} -> firing ${copies}x ${best.profiles[0]!.name}`);
        out.push({ ...best, copies });
      } else if (gunCount) notes.heuristics.push(`${u.name}/${l.model}: pistols not fired (model has other ranged weapons)`);
    }
  }
  return out;
}

function score(p: WeaponProfile): number { return (Number.parseInt(p.S, 10) || 0) - p.AP * 2 + (Number.parseInt(p.D, 10) || 2); }

/** Feel No Pain from ability text (heuristic text extraction; conditional FNPs are skipped and noted). */
export function fnpFrom(entry: UnitEntry, notes: BuildNotes): number | null {
  for (const a of entry.abilities) {
    const m = a.text.match(/Feel No Pain (\d)\+/i);
    if (!m) continue;
    if (/against (psychic|mortal)/i.test(a.text) || /while|if |each time/i.test(a.text.split(/Feel No Pain/i)[0] ?? '')) {
      notes.heuristics.push(`${entry.name}: conditional FNP ${m[1]}+ in "${a.name}" not applied`);
      continue;
    }
    notes.heuristics.push(`${entry.name}: FNP ${m[1]}+ extracted from ability text "${a.name}"`);
    return Number(m[1]);
  }
  return null;
}

/** Invulnerable save: characteristic if present, else parsed from an ability text (heuristic). */
export function invFrom(entry: UnitEntry, profileInSv: number | null, notes: BuildNotes, phase: 'ranged' | 'melee'): number | null {
  if (profileInSv !== null) return profileInSv;
  for (const a of entry.abilities) {
    if (!/invulnerable/i.test(a.name + ' ' + a.text)) continue;
    const m = a.text.match(/(\d)\+\s*(?:invulnerable save|InSv)/i) ?? a.text.match(/InSv[^\d]{0,20}(\d)\+/i) ?? a.text.match(/has a (\d)\+/i);
    if (!m) continue;
    const meleeOnly = /melee/i.test(a.text) && !/ranged/i.test(a.text);
    if (meleeOnly && phase !== 'melee') { notes.heuristics.push(`${entry.name}: InSv ${m[1]}+ is melee-only per text; not applied to ranged`); continue; }
    notes.heuristics.push(`${entry.name}: InSv ${m[1]}+ extracted from ability text "${a.name}"`);
    return Number(m[1]);
  }
  return null;
}

/** Build a Defender from one attached group (characters + bodyguard). */
export function buildDefender(group: RosterUnit[], cat: CatalogIndex, scope: string[], notes: BuildNotes, phase: 'ranged' | 'melee'): Defender {
  const groups: DefenderGroup[] = [];
  const keywords = new Set<string>();
  let T = 0; let bodyT = 0;
  for (const u of group) {
    const e = cat.findUnit(u.name, scope);
    if (!e) { notes.warnings.push(`defender unit "${u.name}" not in BSData; skipped`); continue; }
    for (const k of [...e.keywords, ...e.factionKeywords]) keywords.add(k.toLowerCase());
    keywords.add(norm(e.name));
    const isChar = e.keywords.some((k) => /^character$/i.test(k));
    const fnp = fnpFrom(e, notes);
    const lines = u.models.length ? u.models : [{ name: e.name, count: u.modelCount, wargear: [] }];
    for (const m of lines) {
      const pn = bestModel(m.name, e.profiles.map((p) => p.name)) ?? e.profiles[0]!.name;
      const p = e.profiles.find((x) => x.name === pn)!;
      if (p.T === null || p.W === null || p.Sv === null) { notes.warnings.push(`${e.name}/${p.name}: missing T/W/Sv in BSData`); continue; }
      T = Math.max(T, p.T); if (!isChar) bodyT = Math.max(bodyT, p.T);
      groups.push({ name: `${u.name}: ${m.name}`, count: m.count, W: p.W, Sv: p.Sv, InSv: invFrom(e, p.InSv, notes, phase), fnp, character: isChar && group.length > 1 });
    }
  }
  const useT = bodyT || T;
  if (group.length > 1 && bodyT && bodyT !== T) notes.heuristics.push(`attached unit: using bodyguard T${bodyT} for wound rolls (ASSUMPTION)`);
  return { name: group.map((u) => u.name).join(' + '), T: useT, keywords: [...keywords], groups };
}
