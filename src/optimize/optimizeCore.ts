/**
 * Beam search over "blocks" (a bodyguard with optional Leader/Support/enhancement, or a standalone unit)
 * built only from owned units. Every finished list is re-checked by the validator.
 * Pure: every input (opponent lists, loadout list, collection, catalog) is passed in as data; search.ts is the Node file adapter.
 */
import type { CatalogIndex } from '../catalog/core.ts';
import { pointsFor } from '../catalog/core.ts';
import { norm } from '../bsdata/parse.ts';
import { parseList, attachedGroups } from '../roster/parse.ts';
import type { Roster, RosterUnit } from '../roster/types.ts';
import { buildDefender, type BuildNotes } from '../engine/build.ts';
import { emptyUnit } from '../roster/types.ts';
import { MemoryCellCache, type CellStore } from './cellCache.ts';
import type { Collection } from '../validate/collectionCore.ts';
import { validateRoster, wargearCost } from '../validate/validator.ts';
import { LEE_RULES, SWORD_BRETHREN, CRUSADER_SQUAD, swordBrethrenCap, enhancementLimit, UPGRADE_MAX_UNITS, isUpgrade, enhancementCopies, EPIC_HERO_OVERRIDES, isEpicHero } from '../validate/houseRules.ts';
import { buildTemplates, type Template } from './templates.ts';
import { weaponSlots } from '../engine/build.ts';
import { attackAbilities, defenceAbilities, diceEnhancement, enhancementEffect, offensiveStratsFor, RULE_EFFECTS, type StripStrats } from '../rules/detachments.ts';
import { proxyScore, scoreCell, thFeatures, weightsFor, TIER_TARGETS, type Cell, type OppUnit, type Phase } from './score.ts';

export interface OptimizeOptions {
  faction: string;
  detachments: string[];
  points: number;
  minPoints: number;
  top: number;
  beamWidth: number;
  combosPerBodyguard: number;
  mission: string;
  loadoutList: string | null;
  locks?: { name: string; count: number; models?: number }[];
  baselines?: string[];
  /** Tank killers of any kind, Ballistus included (default 2). */
  minTankKillers?: number;
  /** HARD: tank killers that are NOT a Ballistus Dreadnought block (default 2), checked in addition to minTankKillers. */
  minNonBallistusTankKillers?: number;
  /**
   * HARD (default 2): DEDICATED tank killers, see DEDICATED_TANK_KILLER_DEF. Ballistus, characters and melee INFANTRY bricks never count;
   * 0 disables the rule.
   */
  minDedicatedTankKillers?: number;
  minUnits?: number;
  minBandUnits?: number;
  baselineWarlords?: { file: string; name: string }[];
  /** Canonical Force Disposition (drives tier targets + exported list mission). */
  disposition?: string;
  /** Restrict templates to the army's own catalogue + generic (non-chapter) catalogues (BSData detachment restriction). */
  chapterLocked?: boolean;
  /** Like-for-like detachment comparison: strip generic Codex damage stratagems ('generic') or every offensive stratagem ('all'). */
  stripStrats?: StripStrats;
}

/** HEURISTIC: activations each own block gets in the assignment (one per battle round, rounds 1-3). */
export const ACTIVATIONS_PER_BLOCK = 3;

export interface Block { cellKey: string; id: string; units: RosterUnit[]; templates: Template[]; pts: number; enhancement: string | null; label: string; }

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

/** A text input with the name it came from (file path in Node, a label in the browser). */
export interface SourceText { file: string; text: string; }
/** Data the optimizer reads: opponent lists (scored against), optional loadout list (wargear source) and baseline lists. */
export interface OptimizeData { opponents: SourceText[]; loadout: SourceText | null; baselines?: SourceText[]; }
export interface OptimizeProgress { phase: 'setup' | 'cells' | 'search' | 'validate' | 'done'; done: number; total: number; message: string; }
export interface OptimizeEnv { cache?: CellStore; onProgress?: (p: OptimizeProgress) => void; }

export function opponentsFromTexts(cat: CatalogIndex, sources: SourceText[], notes: BuildNotes): { lists: { file: string; roster: Roster; pts: number }[]; units: OppUnit[] } {
  const lists: { file: string; roster: Roster; pts: number }[] = [];
  const units: OppUnit[] = [];
  for (const { file: f, text } of sources) {
    const r = parseList(text, { catalog: cat, sourceFile: f });
    const scope = cat.scope(r.faction ?? undefined);
    let total = 0;
    attachedGroups(r).forEach((g, i) => {
      const def = buildDefender(g, cat, scope, notes, 'melee');
      if (!def.groups.length) return;
      const pts = g.reduce((s, u) => s + (u.pastedPts ?? 0), 0);
      total += pts;
      units.push({ id: `${f}#${i + 1}`, list: f, label: def.name, pts, def, models: def.groups.reduce((s, x) => s + x.count, 0), attacker: { units: g, scope, faction: r.faction ?? '' } });
    });
    lists.push({ file: f, roster: r, pts: total });
  }
  return { lists, units };
}

function unitPts(cat: CatalogIndex, scope: string[], u: RosterUnit): number {
  const e = cat.findUnit(u.name, scope)!;
  const base = pointsFor(e, u.modelCount, (child) => u.models.filter((m) => norm(m.name).includes(norm(child).replace(/s$/, ''))).reduce((a, m) => a + m.count, 0)) ?? 0;
  return base + (e.wargearPts.length ? wargearCost(u, e.wargearPts) : 0);
}

export function optimizeCore(cat: CatalogIndex, col: Collection, data: OptimizeData, o: OptimizeOptions, env: OptimizeEnv = {}) {
  const t0 = Date.now();
  const progress = env.onProgress ?? (() => {});
  progress({ phase: 'setup', done: 0, total: 1, message: 'building unit templates' });
  const scope = cat.scope(o.faction);
  const notes: BuildNotes = { heuristics: [], warnings: [] };
  const pruned: Record<string, number | string> = {};
  const exportRoster = data.loadout ? parseList(data.loadout.text, { catalog: cat, sourceFile: data.loadout.file }) : null;
  const { templates, notes: tnotes } = buildTemplates(cat, col, o.faction, exportRoster, (o.locks ?? []).filter((l) => l.models !== undefined && !l.name.includes('+')).map((l) => ({ name: l.name, models: l.models! })));
  if (o.chapterLocked) {
    const own = cat.scope(o.faction)[0];
    const before = templates.length;
    for (let i = templates.length - 1; i >= 0; i--) { const c = templates[i]!.entry.catalogue; if (/Adeptus Astartes - /.test(c) && c !== own && !/Adeptus Astartes - Space Marines$/.test(c)) templates.splice(i, 1); }
    pruned.chapterRestriction = `detachment restriction (other-Chapter ADEPTUS ASTARTES units) removed ${before - templates.length} template(s)`;
  }
  const opp = opponentsFromTexts(cat, data.opponents, notes);
  // detachment-filtered offensive stratagems (SECONDARY source, data/stratagems.json); only the chosen detachments' strats apply
  const offStrats = offensiveStratsFor(o.detachments, o.stripStrats ?? 'none');
  pruned.stratagems = `offensive stratagems modelled for [${o.detachments.join(', ')}]: ${offStrats.join(', ') || 'none'}${o.stripStrats && o.stripStrats !== 'none' ? ` (like-for-like: --strip-strats ${o.stripStrats})` : ''}`;
  const hasDet = (d: string) => o.detachments.some((x) => norm(x) === norm(d));
  const fist = hasDet('Fist of the God-Emperor'); const vow = hasDet('Vow-sworn Crusaders');
  const isCrusaderBlock = (b: { units: RosterUnit[] }) => b.units.some((u) => /^crusader squad$/i.test(u.name.trim()));
  const cache: CellStore = env.cache ?? new MemoryCellCache();
  const cell = (units: RosterUnit[], u: OppUnit, ab: string[]): Cell => {
    const k = cache.key([units.map((x) => ({ n: x.name, c: x.modelCount, m: x.models, w: x.unitWargear, a: x.attachedAs, e: x.enhancement })), ab, u.def, u.pts, u.models, o.faction, offStrats]);
    const hit = cache.get(k); if (hit) return hit;
    const v: Cell = scoreCell(cat, scope, units, u, notes, ab, offStrats); cache.set(k, v); return v;
  };
  const WEIGHTS = weightsFor(o.mission);
  const tierTarget = TIER_TARGETS[o.mission] ?? TIER_TARGETS['take-and-hold']!;

  // ---- enhancements usable by the dice engine (others cost points but do not change one-activation output) ----
  const enh = cat.cat.enhancements.filter((e) => scope.includes(e.catalogue) && o.detachments.some((d) => norm(d) === norm(e.detachment)));
  const diceEnh = enh.filter((e) => diceEnhancement(e.name));
  const otherEnh = enh.filter((e) => !diceEnh.includes(e));
  const enhLimit = enhancementLimit(o.points);
  pruned.enhancementRules = `max ${enhLimit.max} enhancements (${enhLimit.source}); "(Upgrade)" enhancements only on non-CHARACTER units, up to ${UPGRADE_MAX_UNITS} units each (each uses a slot, paid each time); ordinary enhancements on CHARACTERS; max 1 per unit incl. attached units; none on Epic Heroes (BSData keyword; overrides: ${EPIC_HERO_OVERRIDES.join(', ')})`;
  pruned.enhancements = `${enh.length} enhancements in [${o.detachments.join(', ')}]: ${enh.map((e) => `${e.name} ${e.pts}pts`).join(', ')}. Engine-modelled (src/rules/detachments.ts): ${diceEnh.map((e) => e.name).join(', ') || 'none'}; the rest are scored by the HEURISTIC enhancement-slot term. Epic Heroes are never given one (ASSUMPTION: core-rules restriction, not checked in BSData).`;

  const autoAb = (b: Block) => attackAbilities(o.detachments, b.units);
  // Angels Defiant (Fist, 1CP; FIST_VOW_TERMS.angelsDefiant): applied to every enemy activation into a block containing a CRUSADER SQUAD (HEURISTIC: CP budget not tracked)
  const defAb = (b: Block) => [...defenceAbilities(o.detachments, b.units), ...(fist && isCrusaderBlock(b) ? ['angels-defiant:block'] : [])];
  pruned.detachmentRules = o.detachments.map((d) => `${d}: ${RULE_EFFECTS[d] ? `${RULE_EFFECTS[d]!.rule} -> ${[...RULE_EFFECTS[d]!.attack, ...RULE_EFFECTS[d]!.defence].join(', ') || `not modelled (${RULE_EFFECTS[d]!.gap})`}` : 'no effect table'}`).join('; ');
  // ---- toughness-band redundancy (list-guide step 04) vs BSData reference units ----
  const bandRefs = BAND_REFS.map((r) => { const e = cat.cat.units.find((x) => x.name === r.unit && x.catalogue === r.catalogue)!; const u = emptyUnit(e.name, null); u.modelCount = r.models;
    const def = buildDefender([u], cat, [e.catalogue, ...cat.scope(undefined)], notes, 'melee');
    return { band: r.band, ref: { id: `band:${r.band}`, list: 'ref', label: `${e.name} x${r.models}`, pts: pointsFor(e, r.models) ?? e.pts ?? 0, def, models: r.models } as OppUnit }; });
  const band = new Map<string, boolean[]>();
  const bandOf = (b: Block) => {
    if (!band.has(b.cellKey)) band.set(b.cellKey, bandRefs.map(({ ref }) => cell(b.units, ref, autoAb(b)).ptsRemoved >= Math.min(80, 0.8 * ref.pts)));
    return band.get(b.cellKey)!;
  };
  // ---- blocks ----
  const chars = templates.filter((t) => t.isCharacter);
  const bodies = templates.filter((t) => !t.isCharacter);
  // Enhancement bearers (Lee's rulings 2026-10-19 + BSData restrictions): ordinary enhancements on CHARACTERS only; "(Upgrade)" enhancements on
  // non-CHARACTER units only; never on an Epic Hero (BSData keyword, plus EPIC_HERO_OVERRIDES where BSData lacks the keyword).
  const eligible = (en: (typeof enh)[number], t: Template) => !isEpicHero(t.entry) && (isUpgrade(en.name) ? !t.isCharacter : t.isCharacter) && (!en.restrictedTo.length || en.restrictedTo.some((r) => norm(r) === norm(t.entry.name) || t.entry.keywords.some((k) => norm(k) === norm(r))));
  const mk = (parts: [Template, RosterUnit['attachedAs']][], enhancement: string | null): Block => {
    const units = parts.map(([t, role]) => { const u = clone(t.unit); u.attachedAs = parts.length > 1 ? role : null; return u; });
    const e = enhancement ? enh.find((x) => x.name === enhancement) : null;
    if (e) {
      // the enhancement goes on a unit that is actually eligible for it (character for ordinary ones, the bodyguard for upgrades), never just the first unit
      const k = parts.findIndex(([t]) => eligible(e, t));
      if (k < 0) throw new Error(`no eligible bearer for ${e.name} in ${parts.map(([t]) => t.entry.name).join(' + ')}`);
      units[k]!.enhancement = e.name;
    }
    for (const u of units) u.pastedPts = unitPts(cat, scope, u) + (u.enhancement && e ? e.pts : 0);
    const pts = units.reduce((s, u) => s + (u.pastedPts ?? 0), 0);
    const baseId = parts.map(([t, r]) => `${r ?? 'solo'}:${t.key}`).join('+');
    return { cellKey: baseId + (e && diceEnh.includes(e) ? `+enh:${e.name}` : ''), id: parts.map(([t, r]) => `${r ?? 'solo'}:${t.key}`).join('+') + (enhancement ? `+enh:${enhancement}` : ''), units, templates: parts.map(([t]) => t), pts, enhancement, label: units.map((u) => u.name).join(' + ') + (enhancement ? ` (${enhancement})` : '') };
  };
  let combos = 0;
  const blocks: Block[] = [];
  // Pure Support characters (no Leader datasheets, only Support ones) must attach: no standalone block (BSData Support link).
  const pureSupport = (t: Template) => !t.entry.leads.length && t.entry.supports.length > 0;
  const soloChars = chars.filter((c) => !pureSupport(c));
  pruned.unattachedSupport = `standalone blocks not generated for pure Support characters: ${[...new Set(chars.filter(pureSupport).map((c) => c.entry.name))].join(', ') || 'none'}`;
  // Lee house rule: no unattached characters (HARD in the optimizer)
  pruned.unattachedCharacters = `no standalone character blocks (Lee house rule): ${[...new Set(soloChars.map((c) => c.entry.name))].join(', ')} only appear attached`;
  for (const b of bodies) {
    blocks.push(mk([[b, null]], null));
    // "(Upgrade)" enhancements on a standalone non-CHARACTER unit (each copy uses one enhancement slot and is paid each time)
    for (const e of enh) if (isUpgrade(e.name) && eligible(e, b)) { blocks.push(mk([[b, null]], e.name)); combos++; }
    const leaders = chars.filter((c) => c.entry.leads.some((x) => norm(x) === norm(b.entry.name)));
    const supports = chars.filter((c) => c.entry.supports.some((x) => norm(x) === norm(b.entry.name)));
    const cand: Block[] = [];
    for (const L of [null, ...leaders]) for (const S of [null, ...supports]) {
      if (!L && !S) continue;
      if (L && S && L.owned === S.owned && L.owned.quantity < 2) continue;
      const parts: [Template, RosterUnit['attachedAs']][] = [[b, 'Bodyguard']];
      if (L) parts.unshift([L, 'Leader']);
      if (S) parts.splice(L ? 1 : 0, 0, [S, 'Support']);
      cand.push(mk(parts, null));
      for (const e of diceEnh) if ([L, S, b].some((x) => x && eligible(e, x))) cand.push(mk(parts, e.name));
    }
    combos += cand.length;
    // prune leader/support combos with a closed-form proxy (expected damage share), keep top K by raw and by per-point
    const scored = cand.map((bl) => ({ bl, s: proxyScore(cat, scope, bl.units, opp.units, notes) }));
    const byRaw = [...scored].sort((a, b) => b.s - a.s).slice(0, o.combosPerBodyguard);
    const byEff = [...scored].sort((a, b) => b.s / b.bl.pts - a.s / a.bl.pts).slice(0, o.combosPerBodyguard);
    // also keep every combo that passes a vehicle band (T10-11 / T12+): those are scarce and the band rule is HARD
    const byBand = scored.filter((x) => { const bb = bandOf(x.bl); return bb[4] || bb[5]; });
    const lockPlus = (o.locks ?? []).filter((l) => l.name.includes('+'));
    const byLock = scored.filter((x) => lockPlus.some((l) => l.name.split('+').every((nm) => x.bl.units.some((u) => norm(u.name) === norm(nm.trim())))));
    for (const x of new Set([...byRaw, ...byEff, ...byBand, ...byLock])) {
      blocks.push(x.bl);
      // non-dice enhancement variants of each kept combo reuse the same exact cells
      if (!x.bl.enhancement) for (const e of otherEnh) {
        const parts = x.bl.templates.map((t, k) => [t, x.bl.units[k]!.attachedAs] as [Template, RosterUnit['attachedAs']]);
        if (parts.some(([t]) => eligible(e, t))) { blocks.push(mk(parts, e.name)); combos++; }
      }
    }
  }
  const keptCombos = blocks.filter((b) => b.units.length > 1).length;
  pruned.attachmentCombos = `${combos} legal leader/support/enhancement combinations; ${keptCombos} kept (top ${o.combosPerBodyguard} per bodyguard by closed-form expected damage, plus top ${o.combosPerBodyguard} per point, plus every combo passing T10-11 or T12+); ${combos - keptCombos} pruned before exact scoring`;

  // ---- tank killers vs real BSData T10-12 vehicles ----
  const refs = TANK_REFS.map((name) => { const e = cat.cat.units.find((x) => x.name === name)!; const u = emptyUnit(name, null); u.modelCount = 1; const def = buildDefender([u], cat, cat.scope(e.catalogue.includes('Chaos') ? 'Chaos Space Marines' : 'Astra Militarum'), notes, 'melee');
    return { id: `ref:${name}`, list: 'ref', label: name, pts: 100, def, models: 1 } as OppUnit; });
  // DEDICATED tank killers (HARD, default 2): the block's non-CHARACTER unit(s) alone (attached leaders/supports ignored), no Ballistus,
  // INFANTRY scored on RANGED weapons only (so melee infantry bricks fail), other units (vehicles, walkers, monsters) on the full activation.
  const needDed = o.minDedicatedTankKillers ?? 2;
  const dedMemo = new Map<string, number>();
  const dedicatedOf = (b: Block): number => {
    const hit = dedMemo.get(b.cellKey); if (hit !== undefined) return hit;
    let v = 0;
    const body = b.units.filter((_, k) => !b.templates[k]?.isCharacter && !/ballistus/i.test(b.units[k]!.name));
    if (b.templates.length && body.length === b.units.filter((_, k) => !b.templates[k]?.isCharacter).length && body.length) {
      const infantry = body.some((u) => cat.findUnit(u.name, scope)?.keywords.some((k) => /^infantry$/i.test(k)));
      const phases: readonly Phase[] = infantry ? ['ranged'] : ['ranged', 'melee'];
      const solo = body.map((u) => ({ ...clone(u), attachedAs: null }));
      const ab = attackAbilities(o.detachments, solo);
      const fr = refs.map((r) => {
        const k = cache.key(['dedicated', phases, solo.map((x) => ({ n: x.name, c: x.modelCount, m: x.models, w: x.unitWargear, e: x.enhancement })), ab, r.def, r.pts, r.models, o.faction, offStrats]);
        let c = cache.get(k); if (!c) { c = scoreCell(cat, scope, solo, r, notes, ab, offStrats, phases); cache.set(k, c); }
        return Math.min(1, c.expDamage / r.def.groups.reduce((a, g) => a + g.count * g.W, 0));
      });
      v = fr.reduce((a, x) => a + x, 0) / fr.length;
    }
    dedMemo.set(b.cellKey, v); return v;
  };
  const isDedicated = (b: Block) => dedicatedOf(b) >= TANK_KILLER_THRESHOLD;
  // Owned units that can be dedicated tank killers (standalone blocks), with how many copies the collection allows.
  const dedicatedOwned = [...new Map(blocks.filter((b) => b.units.length === 1 && isDedicated(b)).map((b) => [b.templates[0]!.owned.name, { unit: b.templates[0]!.owned.name, owned: b.templates[0]!.owned.quantity, score: +dedicatedOf(b).toFixed(3) }])).values()];
  const dedicatedMax = dedicatedOwned.reduce((a, x) => a + x.owned, 0);
  const dedicatedReport = (n: number) => needDed <= 0 ? null : {
    required: needDed, achievable: dedicatedMax, qualifyingOwned: dedicatedOwned,
    message: n >= needDed ? `${n} dedicated tank killers (>= ${needDed} required).`
      : `INFEASIBLE: the rule needs >= ${needDed} DEDICATED tank killers (not the Ballistus, not characters, not melee INFANTRY bricks; INFANTRY must reach the 45% T10-12 test with ranged weapons alone), but the collection allows at most ${dedicatedMax}. Qualifying owned units: ${dedicatedOwned.map((x) => `${x.unit} x${x.owned} (score ${x.score})`).join(', ') || 'none'}. Untick or lower "min dedicated tank killers" to search without it.`,
  };
  progress({ phase: 'cells', done: 0, total: blocks.length, message: `${blocks.length} blocks x ${opp.units.length} opponent units` });
  // ---- exact cells (cached by block id x opponent unit) ----
  const t1 = Date.now();
  const cells = new Map<string, Cell[]>();
  // Short-circuit: when no list can satisfy the HARD dedicated-tank-killer rule, skip the expensive cells/search and report why.
  const shortCircuit = needDed > dedicatedMax;
  let cellsDone = 0;
  if (!shortCircuit) for (const b of blocks) { if (!cells.has(b.cellKey)) cells.set(b.cellKey, opp.units.map((u) => cell(b.units, u, autoAb(b)))); if (++cellsDone % 4 === 0 || cellsDone === blocks.length) progress({ phase: 'cells', done: cellsDone, total: blocks.length, message: `exact cells: block ${cellsDone}/${blocks.length}` }); }
  const tank = new Map<string, number>();
  const tankOf = (b: Block) => {
    if (!tank.has(b.cellKey)) {
      const fr = refs.map((r) => Math.min(1, cell(b.units, r, autoAb(b)).expDamage / r.def.groups.reduce((a, g) => a + g.count * g.W, 0)));
      tank.set(b.cellKey, fr.reduce((a, x) => a + x, 0) / fr.length);
    }
    return tank.get(b.cellKey)!;
  };
  if (!shortCircuit) for (const b of blocks) tankOf(b);
  for (const b of blocks) bandOf(b);
  const pregame = (b: Block) => b.units.some((u) => { const e = cat.findUnit(u.name, scope); return !!e && (e.rules.some((r) => /^(scouts\b|infiltrators$)/i.test(r.name)) || e.keywords.some((k) => /^(scouts|infiltrators)$/i.test(k))); }) || b.units.some((u) => !!enhancementEffect(u.enhancement)?.pregame);
  // HEURISTIC ranged anti-armour: per block, max ranged S among its BSData weapon profiles (copies > 0).
  const maxRS = new Map<string, number>();
  const rangedS = (b: Block) => { if (!maxRS.has(b.cellKey)) { let m = 0; for (const u of b.units) { const e = cat.findUnit(u.name, scope); if (!e) continue; for (const sl of weaponSlots(u, e, notes)) if (sl.copies > 0) for (const p of sl.profiles) if (p.type === 'ranged') { const v = Number.parseInt(p.S, 10); if (Number.isFinite(v)) m = Math.max(m, v); } } maxRS.set(b.cellKey, m); } return maxRS.get(b.cellKey)!; };
  for (const b of blocks) rangedS(b);
  // ---- points at risk: each opponent unit's exact activation INTO each of our blocks (block = defender) ----
  const backMemo = new Map<string, number[]>();
  const backOf = (b: Block): number[] => {
    let v = backMemo.get(b.cellKey); if (v) return v;
    const def = buildDefender(b.units, cat, scope, notes, 'melee');
    const me: OppUnit = { id: `us:${b.cellKey}`, list: 'us', label: b.label, pts: b.pts, def, models: def.groups.reduce((s, x) => s + x.count, 0) };
    v = opp.units.map((u) => {
      if (!u.attacker) return 0;
      const da = defAb(b);
      const k = cache.key(['back', u.attacker.units.map((x) => ({ n: x.name, c: x.modelCount, m: x.models, w: x.unitWargear, a: x.attachedAs, e: x.enhancement })), me.def, me.pts, me.models, u.attacker.faction, da]);
      // enemy strats are not modelled (their detachment is unknown to us): strats = []
      let c = cache.get(k); if (!c) { c = scoreCell(cat, u.attacker.scope, u.attacker.units, me, notes, da, []); cache.set(k, c); }
      return Math.min(b.pts, c.ptsRemoved);
    });
    backMemo.set(b.cellKey, v); return v;
  };
  if (!shortCircuit) for (const b of blocks) backOf(b);
  // HEURISTIC anti-armour COUNT per datasheet (characters count separately), any weapon type: max S over ranged AND melee profiles.
  const unitMaxS = (u: RosterUnit) => { const e = cat.findUnit(u.name, scope); let m = 0; if (!e) return 0; for (const sl of weaponSlots(u, e, notes)) if (sl.copies > 0) for (const p of sl.profiles) { const v = Number.parseInt(p.S, 10); if (Number.isFinite(v)) m = Math.max(m, v); } return m; };
  const cellMs = Date.now() - t1;

  // ---- HEURISTIC detachment movement/objective terms (rules text: FIST_VOW_TERMS in src/rules/detachments.ts) ----
  const infoMemo = new Map<string, { inf: boolean; oc: number; crusOc: number }>();
  const blockInfo = (b: Block) => { const hit = infoMemo.get(b.cellKey); if (hit) return hit; let inf = false; let oc = 0; let crusOc = 0;
    for (const u of b.units) { const e = cat.findUnit(u.name, scope); if (!e) continue;
      const kw = [...e.keywords, ...e.factionKeywords].map((k) => k.toLowerCase());
      if (kw.includes('infantry') && kw.includes('adeptus astartes')) inf = true;
      const f = thFeatures(cat, scope, [{ u, attached: false, pts: 0 }]); oc += f.oc; if (/^crusader squad$/i.test(u.name.trim())) crusOc += f.oc; }
    const v = { inf, oc, crusOc }; infoMemo.set(b.cellKey, v); return v; };
  const detachmentRuleTerms = (bl: Block[]) => {
    const info = bl.map(blockInfo);
    const infBlocks = info.filter((x) => x.inf).length;
    // Heresy Begets Retribution (Vow-sworn): D6" surge must end engaged. P(connect) = mean over enemy end distances 2..8" of P(D6 >= d-1) = 0.5 (HEURISTIC uniform distance);
    // availability saturates at 4 eligible ADEPTUS ASTARTES INFANTRY blocks (HEURISTIC). Once per enemy Movement phase (1CP).
    const hbr = vow ? 0.5 * Math.min(1, infBlocks / 4) : 0;
    // Purge and Sanctify (Fist): needs a surge move; the only sourced surge trigger available here is Heresy Begets Retribution (Vow-sworn).
    // Value = biggest Crusader Squad OC that can be moved onto the closest objective on the enemy turn, / 20 (HEURISTIC normaliser, a 10-man Crusader Squad).
    const bestCrus = Math.max(0, ...info.map((x) => x.crusOc));
    const pas = fist && vow ? Math.min(1, bestCrus / 20) : 0;
    // Uphold the Honour (Vow-sworn Vow): INFANTRY-controlled objectives become secured (sticky). Value = INFANTRY OC share of the list's OC (HEURISTIC).
    const totOc = info.reduce((a, x) => a + x.oc, 0); const infOc = info.filter((x) => x.inf).reduce((a, x) => a + x.oc, 0);
    const uphold = vow && totOc ? infOc / totOc : 0;
    const comps = [hbr, pas, uphold];
    return { value: comps.reduce((a, x) => a + x, 0) / comps.length, heresyBegetsRetribution: +hbr.toFixed(4), purgeAndSanctify: +pas.toFixed(4), upholdTheHonour: +uphold.toFixed(4), label: 'HEURISTIC' };
  };
  // Fragile big vehicle as a top target (Tactician 2026-10-15 #2, SCOUT-FIST Repulsor Executioner): HEURISTIC.
  const vehMemo = new Map<string, boolean>(); const exposureMemo = new Map<string, number>();
  const isBigVehicle = (b: Block) => { let v = vehMemo.get(b.cellKey); if (v === undefined) { v = b.units.some((u) => { const e = cat.findUnit(u.name, scope); return !!e && e.keywords.some((k) => /^(vehicle|monster)$/i.test(k)); }); vehMemo.set(b.cellKey, v); } return v; };
  const fragileVehicleTerm = (bl: Block[], listPts: number) => {
    const rows = bl.filter((b) => b.pts >= FRAGILE_VEHICLE.minPts && isBigVehicle(b)).map((b) => {
      const hit = exposureMemo.get(b.cellKey); if (hit !== undefined) return { block: b.label, pts: b.pts, exposure: hit };
      const back = backOf(b);
      const exposed = listUnits.filter((lu) => lu.some(([, i]) => back[i]! >= FRAGILE_VEHICLE.lossShare * b.pts)).length / Math.max(1, listUnits.length);
      exposureMemo.set(b.cellKey, +exposed.toFixed(3)); return { block: b.label, pts: b.pts, exposure: +exposed.toFixed(3) };
    });
    const pen = rows.reduce((a, r) => a + (r.pts / Math.max(1, listPts)) * r.exposure, 0);
    return { value: Math.max(0, 1 - pen / FRAGILE_VEHICLE.penaltyFull), vehicles: rows, label: 'HEURISTIC' };
  };

  // ---- list objective ----
  const listUnits = opp.lists.map((l) => opp.units.map((u, i) => [u, i] as const).filter(([u]) => u.list === l.file));
  const score = (bl: Block[]) => {
    const perList = opp.lists.map((l, li) => {
      const targets = listUnits[li]!;
      const tot = targets.reduce((s, [u]) => s + u.pts, 0);
      // HEURISTIC assignment: each of our blocks gets ACTIVATIONS_PER_BLOCK activations (one per battle round);
      // greedily give each activation to the (block, target) pair with the largest marginal expected points killed,
      // where a target's survival multiplies (1 - pKill) over every activation already assigned to it.
      const surv = targets.map(() => 1); const remFrac = targets.map(() => 1);
      const left = bl.map(() => ACTIVATIONS_PER_BLOCK);
      const used: { by: string; strat: string | null; pKill: number }[][] = targets.map(() => []);
      for (let step = 0; step < bl.length * ACTIVATIONS_PER_BLOCK; step++) {
        let bi = -1; let ti = -1; let gain = 1e-9;
        for (let b = 0; b < bl.length; b++) {
          if (!left[b]) continue;
          const row = cells.get(bl[b]!.cellKey)!;
          for (let t = 0; t < targets.length; t++) {
            const [u, i] = targets[t]!; const c = row[i]!;
            const g = u.pts * (surv[t]! * c.pKill + 0.25 * remFrac[t]! * Math.min(1, c.ptsRemoved / u.pts) * (1 - c.pKill));
            if (g > gain) { gain = g; bi = b; ti = t; }
          }
        }
        if (bi < 0) break;
        const [u, i] = targets[ti]!; const c = cells.get(bl[bi]!.cellKey)![i]!;
        surv[ti] = surv[ti]! * (1 - c.pKill); remFrac[ti] = remFrac[ti]! * (1 - Math.min(1, c.ptsRemoved / u.pts));
        used[ti]!.push({ by: bl[bi]!.label, strat: c.strat, pKill: +c.pKill.toFixed(4) }); left[bi]!--;
      }
      let kill = 0; let ptsR = 0;
      const unitRows = targets.map(([u], t) => {
        kill += (1 - surv[t]!) * u.pts; ptsR += (1 - remFrac[t]!) * u.pts;
        return { unit: u.label, pts: u.pts, pKill: +(1 - surv[t]!).toFixed(4), expPtsRemoved: +((1 - remFrac[t]!) * u.pts).toFixed(1), assigned: used[t]!, bestAnswer: used[t]!.map((x) => x.by).join(' + ') || '-' };
      });
      const uncovered = targets.filter(([u, i]) => !bl.some((b) => Math.min(1, cells.get(b.cellKey)![i]!.ptsRemoved / u.pts) >= UNCOVERED_LINE)).map(([u]) => u.label);
      const distinct = new Set(used.flat().filter((x) => x.pKill >= 0.5).map((x) => x.by)).size;
      // cost-charged per-block efficiency: mean over (our block, enemy unit) pairs of min(1, points removed / block cost)
      let effSum = 0; for (const b of bl) { const row = cells.get(b.cellKey)!; for (const [u, i] of targets) effSum += Math.min(1, Math.min(u.pts, row[i]!.ptsRemoved) / Math.max(1, b.pts)); }
      const efficiency = bl.length && targets.length ? effSum / (bl.length * targets.length) : 0;
      // points at risk: most points of one of our blocks a single enemy activation removes, as a share of our list
      let maxLoss = 0; let maxLossBy = '-'; let maxLossInto = '-';
      for (const b of bl) { const row = backOf(b); for (const [u, i] of targets) if (row[i]! > maxLoss) { maxLoss = row[i]!; maxLossBy = u.label; maxLossInto = b.label; } }
      const maxLossFrac = maxLoss / Math.max(1, bl.reduce((a, b) => a + b.pts, 0));
      return { opponent: l.file.split('/').pop()!, faction: l.roster.faction, efficiency, maxLossFrac, maxLoss: { pts: +maxLoss.toFixed(1), by: maxLossBy, into: maxLossInto }, killCoverage: tot ? kill / tot : 0, pointsRemovedFrac: tot ? ptsR / tot : 0, independentKillers: distinct, uncoveredProfiles: uncovered, uncoveredFrac: targets.length ? uncovered.length / targets.length : 0, units: unitRows };
    });
    const listPts = bl.reduce((a, b) => a + b.pts, 0);
    const hhi = bl.reduce((a, b) => a + (b.pts / Math.max(1, listPts)) ** 2, 0);
    const aaUnits = { s9: bl.flatMap((b) => b.units.filter((u) => unitMaxS(u) >= 9).map((u) => u.name)), s12: bl.flatMap((b) => b.units.filter((u) => unitMaxS(u) >= 12).map((u) => u.name)) };
    const flat = bl.flatMap((b) => b.units.map((u) => ({ u, attached: b.units.length > 1, pts: unitPts(cat, scope, u) })));
    const th = thFeatures(cat, scope, flat);
    const n = WEIGHTS.normalisers;
    const allUnits = bl.flatMap((b) => b.units);
    const enhCount = allUnits.filter((u) => u.enhancement).length;
    const warlord = allUnits.find((u) => u.warlord) ?? warlordPick(allUnits);
    const cpPerRound = warlord && /helbrecht/i.test(warlord.name) ? 1 : 0;
    const tks = nonBallistusTankKillers(bl.map((b) => ({ label: b.label, tank: tankOf(b) })));
    const dedicated = bl.filter(isDedicated).map((b) => b.label);
    const detRules = detachmentRuleTerms(bl);
    const fragile = fragileVehicleTerm(bl, listPts);
    const parts = {
      killCoverage: perList.reduce((s, x) => s + x.killCoverage, 0) / Math.max(1, perList.length),
      pointsRemoved: perList.reduce((s, x) => s + x.pointsRemovedFrac, 0) / Math.max(1, perList.length),
      oc: Math.min(1, th.oc / n.oc), durability: Math.min(1, th.effectiveWounds / n.effectiveWounds), actionScreen: Math.min(1, th.actionUnits / n.actionUnits),
      unitCount: Math.max(0, Math.min(1, (bl.length - 9) / 6)),
      tierSplit: tierScore(bl, tierTarget),
      bandRedundancy: bandRefs.filter((_, k) => bl.filter((b) => bandOf(b)[k]).length >= 2).length / bandRefs.length,
      pregame: Math.min(1, bl.filter(pregame).length / 2),
      enhancements: Math.min(1, enhCount / 4),
      cp: cpPerRound,
      antiArmourUnits: 0.6 * Math.min(1, aaUnits.s9.length / 6) + 0.4 * Math.min(1, aaUnits.s12.length / 2),
      uncoveredProfiles: 1 - perList.reduce((s, x) => s + x.uncoveredFrac, 0) / Math.max(1, perList.length),
      efficiency: Math.min(1, perList.reduce((s, x) => s + x.efficiency, 0) / Math.max(1, perList.length) / EFFICIENCY_FULL),
      concentration: Math.max(0, Math.min(1, (CONCENTRATION.hhiZero - hhi) / (CONCENTRATION.hhiZero - CONCENTRATION.hhiFull))),
      pointsAtRisk: Math.max(0, 1 - perList.reduce((s, x) => s + x.maxLossFrac, 0) / Math.max(1, perList.length) / POINTS_AT_RISK_ZERO),
      detachmentRules: detRules.value,
      fragileVehicle: fragile.value,
    };
    const antiArmour = { perDatasheetS9plus: aaUnits.s9, perDatasheetS12plus: aaUnits.s12, rangedBlockS9plus: bl.filter((b) => rangedS(b) >= 9).map((b) => b.label), rangedBlockS12plus: bl.filter((b) => rangedS(b) >= 12).map((b) => b.label) };
    const W = WEIGHTS as unknown as Record<string, number>;
    const total = (Object.keys(parts) as (keyof typeof parts)[]).reduce((a, k) => a + W[k]! * parts[k], 0);
    return { total, parts, th, perList, detachmentRuleTerms: detRules, fragileVehicles: fragile, tiers: tiersOf(bl), bands: Object.fromEntries(bandRefs.map(({ band: bn, ref }, k) => [bn, { ref: ref.label, killers: bl.filter((b) => bandOf(b)[k]).map((b) => b.label) }])), pregameUnits: bl.filter(pregame).map((b) => b.label), units: bl.length, enhCount, warlord: warlord?.name ?? null, cpPerRound, tankKillers: tks, dedicatedTankKillers: dedicated, antiArmour };
  };

  // ---- ownership / legality during search ----
  const legal = (bl: Block[]): boolean => {
    const copies = new Map<string, number>(); const models = new Map<string, number>(); const ds = new Map<string, number>();
    for (const b of bl) for (const [k, t] of b.templates.entries()) {
      const u = b.units[k]!;
      copies.set(t.owned.name, (copies.get(t.owned.name) ?? 0) + 1);
      models.set(t.owned.name, (models.get(t.owned.name) ?? 0) + u.modelCount);
      ds.set(t.entry.id, (ds.get(t.entry.id) ?? 0) + 1);
    }
    for (const b of bl) for (const t of b.templates) {
      const c = copies.get(t.owned.name)!; const m = models.get(t.owned.name)!;
      const cap = t.owned.name === SWORD_BRETHREN ? swordBrethrenCap(col.units, copies.get(CRUSADER_SQUAD) ?? 0)! : t.owned.totalModels;
      if (m > cap) return false;
      if (t.owned.modelsPerUnit <= 1 && c > t.owned.quantity) return false;
      if (t.entry.maxPerForce !== null && (ds.get(t.entry.id) ?? 0) > t.entry.maxPerForce) return false;
    }
    const enhs = bl.map((b) => b.enhancement).filter((x): x is string => !!x);
    if (enhs.length > enhLimit.max) return false;
    for (const name of new Set(enhs)) { const e = enh.find((x) => x.name === name); if (enhs.filter((x) => x === name).length > enhancementCopies(e)) return false; }
    if (bl.some((b) => b.units.filter((u) => u.enhancement).length > LEE_RULES.maxEnhancementPerAttachedUnit)) return false;
    return true;
  };

  const locks = o.locks ?? []; const needTk = o.minTankKillers ?? 2; const needNbTk = o.minNonBallistusTankKillers ?? 2;
  const missing = (bl: Block[]) => locks.reduce((a, l) => a + Math.max(0, l.count - bl.filter((b) => l.name.split('+').every((nm) => b.units.some((u) => norm(u.name) === norm(nm.trim()) && (l.models === undefined || u.attachedAs === 'Leader' || u.attachedAs === 'Support' || u.modelCount === l.models)))).length), 0);
  const tkAll = (bl: Block[]) => bl.filter((b) => tankOf(b) >= TANK_KILLER_THRESHOLD).length;
  const tkCount = (bl: Block[]) => nonBallistusTankKillers(bl.map((b) => ({ label: b.label, tank: tankOf(b) }))).length;
  const dedCount = (bl: Block[]) => bl.filter(isDedicated).length;
  const tkDeficit = (bl: Block[]) => Math.max(0, needTk - tkAll(bl)) + Math.max(0, needNbTk - tkCount(bl)) + 2 * Math.max(0, needDed - dedCount(bl));
  const rankKey = (bl: Block[]) => score(bl).total - 0.5 * missing(bl) - 0.05 * tkDeficit(bl) - 0.03 * Math.max(0, minUnits - bl.length) - 0.04 * bandDeficit(bl);
  const minUnits = o.minUnits ?? 11;
  const minBand = o.minBandUnits ?? 2;
  const bandDeficit = (bl: Block[]) => bandRefs.reduce((a, _, k) => a + Math.max(0, minBand - bl.filter((b) => bandOf(b)[k]).length), 0);
  const failingBands = (bl: Block[]) => bandRefs.filter((_, k) => bl.filter((b) => bandOf(b)[k]).length < minBand).map((r, k) => `${r.band} (${bl.filter((b) => bandOf(b)[bandRefs.indexOf(r)]).length})`);
  const done = (bl: Block[]) => missing(bl) === 0 && tkDeficit(bl) === 0 && bl.length >= minUnits && bandDeficit(bl) === 0;
  const nearMiss = new Map<string, { bl: Block[]; pts: number }>();
  // can this partial list still reach minUnits within the points cap? (greedy cheapest legal additions; lookahead prune)
  const byPts = [...blocks].sort((a, b) => a.pts - b.pts);
  const feasible = (bl: Block[], pts: number): boolean => {
    let cur = bl; let p = pts;
    while (cur.length < minUnits) {
      const nb = byPts.find((b) => p + b.pts <= o.points && legal([...cur, b]));
      if (!nb) return false;
      cur = [...cur, nb]; p += nb.pts;
    }
    return true;
  };
  // ---- beam search ----
  const t2 = Date.now();
  type St = { bl: Block[]; idx: number; pts: number; s: number };
  let beam: St[] = shortCircuit ? [] : [{ bl: [], idx: 0, pts: 0, s: 0 }];
  const finished = new Map<string, St>();
  let expanded = 0; let overCap = 0; let illegal = 0; let dropped = 0; let infeasible = 0;
  const sorted = [...blocks].sort((a, b) => a.id.localeCompare(b.id));
  let depth = 0;
  while (beam.length) {
    progress({ phase: 'search', done: ++depth, total: Math.max(depth, minUnits + 4), message: `beam search depth ${depth} (${finished.size} finished lists)` });
    const next: St[] = [];
    for (const st of beam) {
      let grew = false;
      for (let i = 0; i < sorted.length; i++) { // any order; duplicates of the same multiset are removed below
        const b = sorted[i]!;
        if (st.pts + b.pts > o.points) { overCap++; continue; }
        const bl = [...st.bl, b];
        if (!legal(bl)) { illegal++; continue; }
        if (!feasible(bl, st.pts + b.pts)) { infeasible++; continue; }
        expanded++; grew = true;
        next.push({ bl, idx: i, pts: st.pts + b.pts, s: rankKey(bl) });
      }
      if (!grew || st.pts >= o.minPoints) if (st.pts >= o.minPoints && !done(st.bl) && missing(st.bl) === 0 && st.bl.length >= minUnits) nearMiss.set(st.bl.map((b) => b.id).sort().join('|'), { bl: st.bl, pts: st.pts });
      if (st.pts >= o.minPoints && done(st.bl) && st.bl.some((b) => b.templates.some((t) => t.isCharacter))) finished.set(st.bl.map((b) => b.id).sort().join('|'), st);
    }
    next.sort((a, b) => b.s - a.s);
    // dedupe same multiset
    const seen = new Set<string>(); const uniq: St[] = [];
    for (const s of next) { const k = s.bl.map((b) => b.id).sort().join('|'); if (!seen.has(k)) { seen.add(k); uniq.push(s); } }
    dropped += Math.max(0, uniq.length - o.beamWidth);
    beam = uniq.slice(0, o.beamWidth);
  }
  const searchMs = Date.now() - t2;
  pruned.search = `beam width ${o.beamWidth}: ${expanded} partial lists scored; ${overCap} expansions cut for exceeding ${o.points} pts; ${illegal} cut for ownership/datasheet/enhancement limits; ${infeasible} cut because ${minUnits} units could no longer fit; ${dropped} dropped by the beam`;

  progress({ phase: 'validate', done: 0, total: 1, message: `validating ${finished.size} finished lists` });
  // ---- finalize: validate with the real validator, rank ----
  const ranked = [...finished.values()].map((x) => ({ ...x, s: score(x.bl).total })).sort((a, b) => b.s - a.s);
  const results: unknown[] = []; let rejected = 0;
  const composition = (bl: Block[]) => bl.map((b) => b.units.map((u) => `${u.attachedAs ?? 'solo'}:${u.name}#${u.modelCount}`).join('+')).sort().join('|');
  const byComp = new Map<string, typeof ranked>();
  for (const st of ranked) { const k = composition(st.bl); (byComp.get(k) ?? byComp.set(k, []).get(k)!).push(st); }
  let collapsed = 0;
  for (const st of ranked) {
    if (results.length >= o.top) break;
    const group = byComp.get(composition(st.bl))!;
    if (group[0] !== st) { collapsed++; continue; }
    const roster = toRoster(st.bl, o);
    const v = validateRoster(roster, cat, { collection: col, pointsLimit: o.points });
    if (!v.ok) { rejected++; continue; }
    const sc = score(st.bl);
    results.push({
      rank: results.length + 1, score: +sc.total.toFixed(4), points: st.pts, detachments: o.detachments,
      units_count: sc.units, enhancements: roster.units.filter((u) => u.enhancement).map((u) => `${u.enhancement} on ${u.name}`), warlord: sc.warlord, cpPerRound: sc.cpPerRound,
      antiArmour: sc.antiArmour, tankKillers: sc.tankKillers, dedicatedTankKillers: sc.dedicatedTankKillers, tankKillerDefinition: TANK_KILLER_DEF, dedicatedTankKillerDefinition: DEDICATED_TANK_KILLER_DEF, tiers: sc.tiers, bands: sc.bands, pregameUnits: sc.pregameUnits,
      alternateEnhancementPlacements: group.slice(1).map((g) => `score ${score(g.bl).total.toFixed(4)}, ${g.pts} pts: ${g.bl.filter((b) => b.enhancement).map((b) => `${b.enhancement} on ${b.units.find((u) => u.enhancement)?.name}`).join('; ')}`),
      scoreParts: Object.fromEntries(Object.entries(sc.parts).map(([k, v]) => [k, +v.toFixed(4)])),
      takeAndHold: { oc: sc.th.oc, effectiveWoundsVsS5AP1: +sc.th.effectiveWounds.toFixed(1), actionUnits: sc.th.actionUnits, label: 'HEURISTIC' },
      units: st.bl.map((b) => ({ block: b.label, pts: b.pts, tankScore: +tankOf(b).toFixed(3), dedicatedTankScore: +dedicatedOf(b).toFixed(3), loadoutSources: b.templates.map((t) => `${t.entry.name}: ${t.loadoutSource}${t.note ? ` (${t.note})` : ''}`) })),
      perMatchup: sc.perList.map((p) => ({ ...p, killCoverage: +p.killCoverage.toFixed(4), pointsRemovedFrac: +p.pointsRemovedFrac.toFixed(4) })),
      reasons: [...reasons(sc, st.bl), `Detachments: ${o.detachments.join(' + ')} (BSData names; detachment rules themselves are not modelled by the engine). Warlord ${sc.warlord ?? '-'}${sc.cpPerRound ? ' (+1 CP per battle round from Transhuman Strategist, BSData)' : ''}. ${sc.enhCount} enhancement(s). Tank killers (excl. Ballistus): ${sc.tankKillers.join('; ') || 'none'}. Dedicated tank killers: ${sc.dedicatedTankKillers.join('; ') || 'none'}.`],
      validation: { ok: v.ok, warnings: v.issues.filter((i) => i.severity === 'warning').map((i) => `${i.code}: ${i.unit ?? ''} ${i.message}`.trim()) },
      roster,
    });
  }
  pruned.validatorRejected = rejected;
  pruned.collapsed = `${collapsed} lists folded into a higher-ranked entry with the same units (differing only in enhancement choice/placement); see alternateEnhancementPlacements`;
  const tankTable = Object.fromEntries([...new Map(blocks.filter((b) => b.units.length === 1 && !b.enhancement).map((b) => [b.label, +tankOf(b).toFixed(3)])).entries()].sort((a, b) => b[1] - a[1]));
  const infeasibility = finished.size ? null : {
    message: shortCircuit ? dedicatedReport(dedicatedMax)!.message : `No list found at ${o.points} pts that meets every HARD constraint (>= ${minBand} units passing every toughness band, >= ${minUnits} units, >= ${needTk} tank killers incl. Ballistus AND >= ${needNbTk} non-Ballistus tank killers${needDed > 0 ? ` AND >= ${needDed} dedicated tank killers` : ''}, locks). The rule was NOT relaxed. Closest lists (all other constraints met) follow.`,
    closest: [...nearMiss.values()].map((x) => ({ x, d: bandDeficit(x.bl), s: score(x.bl).total })).sort((a, b) => a.d - b.d || b.s - a.s).slice(0, 3).map(({ x, d, s: sc2 }) => ({
      bandDeficit: d, failingBands: failingBands(x.bl), tankKillers: tkCount(x.bl), score: +sc2.toFixed(4), points: x.pts, units: x.bl.map((b) => `${b.label} (${b.pts})`) })),
    bandCapability: Object.fromEntries(bandRefs.map((r, k) => [r.band, [...new Set(blocks.filter((b) => bandOf(b)[k]).map((b) => b.label.replace(/ \(.*\)$/, '')))].slice(0, 12)])),
    dedicatedTankKillers: shortCircuit ? dedicatedReport(dedicatedMax) : needDed > 0 ? { required: needDed, achievable: dedicatedMax, qualifyingOwned: dedicatedOwned, message: `Dedicated tank killers available (${dedicatedMax}, need ${needDed}): ${dedicatedOwned.map((x) => `${x.unit} x${x.owned}`).join(', ')}; taking them leaves no list that also meets the other HARD rules (see closest lists).` } : null,
  };
  pruned.locksAndAntiTank = `lists must contain ${locks.map((l) => `${l.name} x${l.count}`).join(', ') || 'no locked units'} and >= ${needTk} tank killers (any) and >= ${needNbTk} non-Ballistus tank killers and >= ${needDed} dedicated tank killers (owned qualifying: ${dedicatedOwned.map((x) => `${x.unit} x${x.owned}`).join(', ') || 'none'}) and >= ${minUnits} units and >= ${minBand} units passing every toughness band (HARD); ${finished.size} finished lists met this`;
  // ---- baselines: given lists scored on the same metric (no search) ----
  const baselines = (data.baselines ?? []).map(({ file: f, text }) => {
    const r = parseList(text, { catalog: cat, sourceFile: f });
    const wo = (o.baselineWarlords ?? []).find((w) => f.endsWith(w.file));
    let warlordSource = r.units.some((u) => u.warlord) ? 'parsed from list' : 'none in list';
    if (wo) { const t = r.units.find((u) => norm(u.name) === norm(wo.name)); if (!t) throw new Error(`--warlord: ${wo.name} not in ${f}`); for (const u of r.units) u.warlord = u === t; warlordSource = `--warlord override (${wo.name})`; }
    const bs: Block[] = attachedGroups(r).map((g, i) => {
      const en = g.find((u) => u.enhancement)?.enhancement ?? null;
      const key = `baseline:${f}#${i}`;
      return { cellKey: key, id: key, units: g, templates: [], pts: g.reduce((a, u) => a + (u.pastedPts ?? 0), 0), enhancement: en, label: g.map((u) => u.name).join(' + ') + (en ? ` (${en})` : '') };
    });
    for (const b of bs) cells.set(b.cellKey, opp.units.map((u) => cell(b.units, u, autoAb(b))));
    const sc = score(bs);
    const v = validateRoster(r, cat, { collection: col, pointsLimit: o.points });
    return { file: f, name: r.name, score: +sc.total.toFixed(4), scoreParts: Object.fromEntries(Object.entries(sc.parts).map(([k, x]) => [k, +x.toFixed(4)])), points: bs.reduce((a, b) => a + b.pts, 0),
      units_count: sc.units, enhancements: sc.enhCount, warlord: sc.warlord, warlordSource, tiers: sc.tiers, bands: sc.bands, pregameUnits: sc.pregameUnits, cpPerRound: sc.cpPerRound, tankKillers: sc.tankKillers,
      antiArmour: sc.antiArmour, perMatchup: sc.perList.map((p) => ({ opponent: p.opponent, killCoverage: +p.killCoverage.toFixed(4), uncoveredProfiles: p.uncoveredProfiles })),
      validation: { ok: v.ok, errors: v.issues.filter((i) => i.severity === 'error').map((i) => `${i.code}: ${i.unit ?? ''} ${i.message}`) } };
  }).sort((a, b) => b.score - a.score);
  progress({ phase: 'done', done: 1, total: 1, message: `${results.length} list(s)` });
  return {
    mission: o.mission, points: o.points, minPoints: o.minPoints, faction: o.faction, detachments: o.detachments,
    collection: { path: col.path, status: col.status }, opponents: opp.lists.map((l) => ({ file: l.file, faction: l.roster.faction, units: opp.units.filter((u) => u.list === l.file).length })),
    weights: WEIGHTS, templates: templates.map((t) => ({ key: t.key, source: t.loadoutSource, note: t.note })), templateNotes: tnotes,
    cache: (cache.save(), cache.stats()), pruned, runtimeMs: { total: Date.now() - t0, exactCells: cellMs, search: searchMs }, counts: { blocks: blocks.length, opponentUnits: opp.units.length, exactCells: blocks.length * opp.units.length },
    infeasibility, tankKillerDefinition: TANK_KILLER_DEF, dedicatedTankKillerDefinition: DEDICATED_TANK_KILLER_DEF, dedicatedTankKillers: dedicatedReport(Math.min(dedicatedMax, needDed)), tankScoreSoloBlocks: tankTable, results, baselines, heuristics: [...new Set(notes.heuristics)].slice(0, 200), warnings: [...new Set(notes.warnings)].slice(0, 200),
  };
}

function reasons(sc: { parts: Record<string, number>; perList: { opponent: string; killCoverage: number; independentKillers: number; units: { unit: string; pts: number; pKill: number; bestAnswer: string; assigned: { by: string; pKill: number }[] }[] }[]; th: { oc: number; actionUnits: number } }, bl: Block[]): string[] {
  const out: string[] = [];
  const best = [...sc.perList].sort((a, b) => b.killCoverage - a.killCoverage);
  if (best.length) out.push(`Best matchup: ${best[0]!.opponent} (points-weighted one-activation kill chance ${(best[0]!.killCoverage * 100).toFixed(0)}%); worst: ${best[best.length - 1]!.opponent} (${(best[best.length - 1]!.killCoverage * 100).toFixed(0)}%).`);
  const answers = new Map<string, number>();
  for (const l of sc.perList) for (const u of l.units) for (const a of u.assigned) if (a.pKill >= 0.5) answers.set(a.by, (answers.get(a.by) ?? 0) + 1);
  const top = [...answers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length) out.push(`Main killers (assigned activations with >=50% kill chance, summed over ${sc.perList.length} opponents): ${top.map(([k, n]) => `${k} x${n}`).join('; ')}. Mean independent killers per matchup: ${(sc.perList.reduce((s, l) => s + l.independentKillers, 0) / Math.max(1, sc.perList.length)).toFixed(1)}.`);
  const holes = sc.perList.flatMap((l) => l.units.map((u) => ({ ...u, opp: l.opponent }))).filter((u) => u.pKill < 0.1 && u.pts >= 150).sort((a, b) => b.pts - a.pts).slice(0, 4);
  if (holes.length) out.push(`Hard to remove in one activation: ${holes.map((h) => `${h.unit} (${h.opp}, ${h.pts} pts, best ${(h.pKill * 100).toFixed(0)}%)`).join('; ')}.`);
  out.push(`Take and Hold (heuristic): OC ${sc.th.oc}, ${sc.th.actionUnits} cheap action/screen units, durability score ${(sc.parts.durability! * 100).toFixed(0)}% of the normaliser.`);
  void bl;
  return out;
}

/** Convert a block list into a Roster (attach groups numbered) for validation and export. */
export function toRoster(bl: Block[], o: OptimizeOptions): Roster {
  const units: RosterUnit[] = [];
  let g = 0;
  const chars: RosterUnit[] = [];
  for (const b of bl) {
    if (b.units.length > 1) { g++; for (const u of b.units) units.push({ ...clone(u), attachGroup: g, section: 'ATTACHED UNITS' }); }
  }
  for (const b of bl) if (b.units.length === 1) { const u = clone(b.units[0]!); u.section = b.templates[0]!.isCharacter ? 'CHARACTERS' : 'OTHER DATASHEETS'; (b.templates[0]!.isCharacter ? chars : units).push(u); }
  const all = [...units.filter((u) => u.attachGroup !== null), ...chars, ...units.filter((u) => u.attachGroup === null)];
  // warlord: Helbrecht if present (Transhuman Strategist, per reference card), else the most expensive character  (HEURISTIC)
  const cands = all.filter((u) => u.attachedAs === 'Leader' || u.attachedAs === 'Support' || u.section === 'CHARACTERS');
  const wl = warlordPick(cands);
  if (wl) wl.warlord = true;
  return {
    format: 'gw-app', sourceFile: null, name: `crucible optimize ${o.mission}`, player: null, faction: o.faction, factionLines: ['Space Marines', o.faction],
    detachments: o.detachments, mission: o.disposition ?? (o.mission === 'purge' ? 'Purge the Foe' : 'Take and Hold'), battleSize: `Strike Force (${o.points} points)`, declaredPoints: all.reduce((s, u) => s + (u.pastedPts ?? 0), 0), units: all, warnings: [],
  };
}

/** HEURISTIC warlord pick: Helbrecht if present (BSData Transhuman Strategist: +1 CP at the start of each battle round if WARLORD), else the first character. */
export function warlordPick(units: RosterUnit[]): RosterUnit | undefined {
  return units.find((u) => /helbrecht/i.test(u.name)) ?? units.find((u) => u.attachedAs === 'Leader' || u.attachedAs === 'Support' || u.section === 'CHARACTERS');
}

/** Reference T10-12 VEHICLE datasheets from BSData used to define a tank killer. */
export const UNCOVERED_LINE = 0.65;
/** HEURISTIC concentration normalisers (author-chosen): HHI of block points 0.08 (about 12 equal blocks) scores 1, 0.20 (about 5 equal blocks) scores 0. */
export const CONCENTRATION = { hhiFull: 0.08, hhiZero: 0.20 };
/** HEURISTIC (author-chosen): a VEHICLE/MONSTER block of >= 200 pts is "fragile" vs an opponent list if one enemy activation removes >= 50% of its points; score 0 when (share of list points) x (share of opponent lists exposing it) reaches 0.10. */
export const FRAGILE_VEHICLE = { minPts: 200, lossShare: 0.5, penaltyFull: 0.10 };
/** HEURISTIC: a single enemy activation removing 25% of our list points scores 0 on pointsAtRisk (author-chosen). */
export const POINTS_AT_RISK_ZERO = 0.25;
/** HEURISTIC: mean cost-charged pair efficiency of 0.40 scores 1 on the efficiency part (author-chosen; observed range 0.17-0.33). */
export const EFFICIENCY_FULL = 0.40;
export const TANK_REFS = ['Leman Russ Battle Tank', 'Chaos Land Raider', 'Chaos Predator Annihilator'];
export const TANK_KILLER_THRESHOLD = 0.45; // Tactician decision 2026-10-15 (was 0.5)
/** Labels of blocks that pass the tank-killer test (>= TANK_KILLER_THRESHOLD) and contain no Ballistus Dreadnought. */
export const nonBallistusTankKillers = (bl: { label: string; tank: number }[]) => bl.filter((b) => !/ballistus/i.test(b.label) && b.tank >= TANK_KILLER_THRESHOLD).map((b) => b.label);
export const TANK_KILLER_DEF = 'HEURISTIC: a block is a tank killer if, in one activation (all ranged then all melee, charged, best eligible strat, exact engine), its expected damage averages >= 45% of the target wounds across three BSData T10-12 vehicles: Leman Russ Battle Tank (T11 W13 2+), Chaos Land Raider (T12 W16 2+), Chaos Predator Annihilator (T10 W11 3+). HARD: >= 2 such blocks must be non-Ballistus (a Ballistus block never counts towards that minimum), in addition to --min-tank-killers counting all tank killers.';
export const DEDICATED_TANK_KILLER_DEF = 'HEURISTIC (Lee rule 2026-10-19, HARD, default --min-dedicated-tank-killers 2): a DEDICATED tank killer is a block whose non-CHARACTER unit, scored alone (attached leaders/supports ignored), passes the same >= 45% wounds test vs the three BSData T10-12 vehicles. Ballistus Dreadnought never counts; INFANTRY is scored on RANGED weapons only, so melee infantry bricks (Crusader Squad, Terminator Assault Squad, Sword Brethren) do not count while e.g. Eradicators can; vehicles/walkers (Repulsor Executioner, Brutalis Dreadnought, Land Raider types) use the full activation.';
export { MAX_ENHANCEMENTS, enhancementLimit, UPGRADE_MAX_UNITS, isUpgrade, enhancementCopies, EPIC_HERO_OVERRIDES, isEpicHero } from '../validate/houseRules.ts';

/** list-guide.txt step 04 bands, one BSData reference per band (the guide's own examples where BSData has them). */
export const BAND_REFS = [
  { band: 'T3-4', unit: 'Cadian Shock Troops', catalogue: 'Imperium - Astra Militarum - Library', models: 10 },
  { band: 'T5', unit: 'Intercessor Squad', catalogue: 'Imperium - Adeptus Astartes - Space Marines', models: 5 },
  { band: 'T6', unit: 'Terminator Squad', catalogue: 'Imperium - Adeptus Astartes - Space Marines', models: 5 },
  { band: 'T7-9', unit: 'Rhino', catalogue: 'Imperium - Grey Knights', models: 1 },
  { band: 'T10-11', unit: 'Leman Russ Battle Tank', catalogue: 'Imperium - Astra Militarum - Library', models: 1 },
  { band: 'T12+', unit: 'Land Raider', catalogue: 'Imperium - Grey Knights', models: 1 },
];
/** list-guide.txt tiers: Heavies 200+, Workhorses 115-195, Utility under 115 (an attached unit counts once at its combined points). */
export function tiersOf(bl: { pts: number }[]): { heavies: number; workhorses: number; utility: number } {
  return { heavies: bl.filter((b) => b.pts >= 200).length, workhorses: bl.filter((b) => b.pts >= 115 && b.pts < 200).length, utility: bl.filter((b) => b.pts < 115).length };
}
/** 1 at the Take and Hold median 3/4/4, minus 1/6 per unit of L1 distance (HEURISTIC). */
export function tierScore(bl: { pts: number }[], target: [number, number, number] = [3, 4, 4]): number {
  const t = tiersOf(bl);
  return Math.max(0, 1 - (Math.abs(t.heavies - target[0]) + Math.abs(t.workhorses - target[1]) + Math.abs(t.utility - target[2])) / 6);
}
