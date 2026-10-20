/** Roster validation against BSData + Lee's house rules + optional collection limits. */
import type { CatalogIndex } from '../catalog/core.ts';
import { pointsFor } from '../catalog/core.ts';
import { norm } from '../bsdata/parse.ts';
import type { Roster, RosterUnit } from '../roster/types.ts';
import { attachedGroups } from '../roster/parse.ts';
import type { Collection } from './collectionCore.ts';
import { detachmentPointLimit } from '../select/selectionCore.ts';
import { LEE_RULES, SWORD_BRETHREN, CRUSADER_SQUAD, swordBrethrenCap, enhancementLimit, enhancementCopies, isUpgrade, isUpgradeEnh, isEpicHero, enhancementSlots, UPGRADE_SLOT_RULE } from './houseRules.ts';

export type Severity = 'error' | 'warning' | 'info';
export interface Issue { severity: Severity; code: string; unit?: string; message: string; source: 'bsdata' | 'house-rule' | 'collection' | 'parser'; }

export interface UnitCheck {
  name: string;
  matched: string | null;
  catalogue: string | null;
  models: number;
  pastedPts: number | null;
  bsdataPts: number | null;
  enhancement: string | null;
  enhancementPts: number | null;
  expectedPts: number | null;
  pointsMatch: boolean | null;
}

export interface ValidationResult {
  ok: boolean;
  totals: { pasted: number; bsdata: number | null; declared: number | null; limit: number | null };
  units: UnitCheck[];
  issues: Issue[];
  collection: { status: Collection['status']; path: string } | null;
}

export interface ValidateOptions { collection?: Collection | null; houseRules?: boolean; pointsLimit?: number | null; }

export function validateRoster(r: Roster, cat: CatalogIndex, opts: ValidateOptions = {}): ValidationResult {
  const issues: Issue[] = [];
  const scope = cat.scope(r.faction ?? undefined);
  if (!scope.length) issues.push({ severity: 'error', code: 'faction-unknown', message: `faction "${r.faction}" not matched to a BSData catalogue`, source: 'bsdata' });
  for (const w of r.warnings) issues.push({ severity: 'info', code: 'parse-note', message: w, source: 'parser' });

  const copies = new Map<string, number>();
  const units: UnitCheck[] = [];
  let bsTotal = 0; let bsComplete = true;
  const enhSeen = new Map<string, string>();
  const enhCopies = new Map<string, number>(); const enhNames: { name: string; text?: string }[] = [];

  for (const u of r.units) {
    const e = cat.findUnit(u.name, scope);
    const chk: UnitCheck = { name: u.name, matched: e?.name ?? null, catalogue: e?.catalogue ?? null, models: u.modelCount, pastedPts: u.pastedPts, bsdataPts: null, enhancement: u.enhancement, enhancementPts: null, expectedPts: null, pointsMatch: null };
    units.push(chk);
    if (!e) { issues.push({ severity: 'error', code: 'unit-unknown', unit: u.name, message: 'unit not found in BSData for this faction', source: 'bsdata' }); bsComplete = false; continue; }
    if (scope.length && !scope.includes(e.catalogue)) issues.push({ severity: 'warning', code: 'unit-out-of-scope', unit: u.name, message: `matched in ${e.catalogue}, outside faction scope`, source: 'bsdata' });
    const sizeUncertain = !!e.sizeNote || (e.entryType === 'unit' && e.minModels === e.maxModels && e.modelNames.length > 1);
    if (u.modelCount < e.minModels || u.modelCount > e.maxModels)
      issues.push({ severity: sizeUncertain ? 'warning' : 'error', code: sizeUncertain ? 'unit-size-unverified' : 'unit-size', unit: u.name, message: `${u.modelCount} models; BSData allows ${e.minModels}-${e.maxModels}`, source: 'bsdata' });
    const n = (copies.get(e.id) ?? 0) + 1; copies.set(e.id, n);
    let pts = pointsFor(e, u.modelCount, (child) => u.models.filter((m) => norm(m.name).includes(norm(child).replace(/s$/, ''))).reduce((a, m) => a + m.count, 0));
    if (pts !== null && e.duplicateSurcharge && n >= e.duplicateSurcharge.fromCopy) pts += e.duplicateSurcharge.add;
    if (pts === null && Object.keys(e.modelPts).length) {
      // cost lives on model entries
      pts = 0;
      for (const m of u.models.length ? u.models : [{ name: u.name, count: u.modelCount, wargear: [] }]) {
        const k = bestModel(m.name, Object.keys(e.modelPts));
        pts += (k ? e.modelPts[k]! : Object.values(e.modelPts)[0]!) * m.count;
      }
    }
    if (pts !== null && e.wargearPts.length) pts += wargearCost(u, e.wargearPts);
    chk.bsdataPts = pts;
    if (e.sizeNote) issues.push({ severity: 'info', code: 'bsdata-size-note', unit: u.name, message: e.sizeNote, source: 'bsdata' });
    let enhPts = 0;
    if (u.enhancement) {
      const en = cat.findEnhancement(u.enhancement, scope);
      if (!en) { issues.push({ severity: 'error', code: 'enhancement-unknown', unit: u.name, message: `enhancement "${u.enhancement}" not in BSData`, source: 'bsdata' }); }
      else {
        enhPts = en.pts; chk.enhancementPts = en.pts;
        if (en.detachment && r.detachments.length && !r.detachments.some((d) => norm(d) === norm(en.detachment)))
          issues.push({ severity: 'warning', code: 'enhancement-detachment', unit: u.name, message: `${en.name} belongs to ${en.detachment}, not in roster detachments [${r.detachments.join(', ')}]`, source: 'bsdata' });
        if (en.restrictedTo.length && !en.restrictedTo.some((x) => norm(x) === norm(e.name) || e.keywords.some((k) => norm(k) === norm(x))))
          issues.push({ severity: 'error', code: 'enhancement-bearer', unit: u.name, message: `${en.name} restricted to ${en.restrictedTo.join('/')}; ${e.name} is not eligible`, source: 'bsdata' });
        const prev = enhSeen.get(norm(en.name));
        const copies = (enhCopies.get(norm(en.name)) ?? 0) + 1; enhCopies.set(norm(en.name), copies); enhNames.push(en);
        if (prev && copies > enhancementCopies(en)) issues.push({ severity: 'error', code: 'enhancement-duplicate', unit: u.name, message: `${en.name} already taken by ${prev} (max ${enhancementCopies(en)}${isUpgradeEnh(en) ? ' units for an Upgrade' : ''})`, source: isUpgradeEnh(en) ? 'house-rule' : 'bsdata' });
        enhSeen.set(norm(en.name), u.name);
        const isChar = e.keywords.some((k) => /^character$/i.test(k)) || e.leads.length > 0 || e.supports.length > 0;
        if (isEpicHero(e)) issues.push({ severity: 'error', code: 'enhancement-epic-hero', unit: u.name, message: `${e.name} is an Epic Hero and cannot take ${en.name}`, source: 'house-rule' });
        if (isUpgradeEnh(en) && isChar) issues.push({ severity: 'error', code: 'enhancement-upgrade-bearer', unit: u.name, message: `${en.name} is an Upgrade: non-CHARACTER units only`, source: 'house-rule' });
        if (!isUpgradeEnh(en) && !isChar) issues.push({ severity: 'error', code: 'enhancement-bearer-character', unit: u.name, message: `${en.name} can only be given to a CHARACTER`, source: 'house-rule' });
        if (u.enhancementPts !== null && u.enhancementPts !== en.pts)
          issues.push({ severity: 'warning', code: 'enhancement-points-mismatch', unit: u.name, message: `pasted +${u.enhancementPts}, BSData ${en.pts}`, source: 'bsdata' });
      }
    }
    if (pts === null) { bsComplete = false; continue; }
    chk.expectedPts = pts + enhPts;
    bsTotal += chk.expectedPts;
    if (u.pastedPts !== null) {
      // New Recruit text lists enhancement separately; App/BCP fold it into the unit line.
      const alt = pts; // pasted excluding enhancement
      chk.pointsMatch = u.pastedPts === chk.expectedPts || (r.format === 'newrecruit-text' && u.pastedPts === alt);
      if (!chk.pointsMatch)
        issues.push({ severity: 'warning', code: 'points-mismatch', unit: u.name, message: `pasted ${u.pastedPts}, BSData ${chk.expectedPts} (${pts} for ${u.modelCount} models${enhPts ? ` + ${enhPts} enhancement` : ''})`, source: 'bsdata' });
    }
  }
  for (const [id, n] of copies) {
    const e = cat.cat.units.find((x) => x.id === id)!;
    if (e.maxPerForce !== null && n > e.maxPerForce) issues.push({ severity: 'error', code: 'datasheet-limit', unit: e.name, message: `${n} copies; BSData max ${e.maxPerForce}`, source: 'bsdata' });
  }

  {
    const lim = enhancementLimit(opts.pointsLimit ?? r.declaredPoints ?? 2000);
    const slots = enhancementSlots(enhNames);
    // Detachment Points: roster total vs the BSData limit for the battle size (Strike Force 3)
    const dpLim = detachmentPointLimit(opts.pointsLimit ?? r.declaredPoints ?? 2000);
    const dEntries = r.detachments.map((n) => ({ n, d: (cat.cat.detachments ?? []).find((x) => norm(x.name) === norm(n)) }));
    const unknown = dEntries.filter((x) => !x.d).map((x) => x.n);
    if (unknown.length) issues.push({ severity: 'warning', code: 'detachment-unknown', message: `detachment(s) not found in BSData: ${unknown.join(', ')}`, source: 'bsdata' });
    const dpTotal = dEntries.reduce((s, x) => s + (x.d?.detachmentPoints ?? 0), 0);
    if (dpLim && dEntries.every((x) => x.d && x.d.detachmentPoints !== null) && dpTotal > dpLim.max)
      issues.push({ severity: 'error', code: 'detachment-points', message: `${dEntries.map((x) => `${x.n} (${x.d!.detachmentPoints} DP)`).join(' + ')} = ${dpTotal} DP exceeds ${dpLim.max} (${dpLim.battleSize}; ${dpLim.source})`, source: 'bsdata' });
    if (slots > lim.max) issues.push({ severity: 'error', code: 'enhancement-limit', message: `${slots} enhancement slots used by ${enhNames.length} enhancements (max ${lim.max}: ${lim.source}; ${UPGRADE_SLOT_RULE})`, source: 'house-rule' });
  }
  // attached units
  for (const g of attachedGroups(r)) {
    if (g.length < 2) continue;
    const leaders = g.filter((u) => u.attachedAs === 'Leader');
    const supports = g.filter((u) => u.attachedAs === 'Support');
    const body = g.find((u) => u.attachedAs === 'Bodyguard') ?? g.find((u) => !u.attachedAs);
    const label = g.map((u) => u.name).join(' + ');
    const gap = [...leaders, ...supports].some((c) => { const e = cat.findUnit(c.name, scope); return !!e && !e.leads.length && !e.supports.length; });
    if (leaders.length > LEE_RULES.maxLeaderPerUnit) issues.push({ severity: gap ? 'warning' : 'error', code: 'leader-max', unit: label, message: `${leaders.length} Leaders (max ${LEE_RULES.maxLeaderPerUnit})${gap ? '; BSData lacks association data for at least one, so the pasted role labels cannot be verified' : ''}`, source: 'house-rule' });
    if (supports.length > LEE_RULES.maxSupportPerUnit) issues.push({ severity: 'error', code: 'support-max', unit: label, message: `${supports.length} Supports (max ${LEE_RULES.maxSupportPerUnit})`, source: 'house-rule' });
    const enh = g.filter((u) => u.enhancement).length;
    if (enh > LEE_RULES.maxEnhancementPerAttachedUnit) issues.push({ severity: 'error', code: 'enhancement-per-unit', unit: label, message: `${enh} enhancements in one attached unit (max ${LEE_RULES.maxEnhancementPerAttachedUnit})`, source: 'house-rule' });
    if (!body) { issues.push({ severity: 'warning', code: 'no-bodyguard', unit: label, message: 'attached group without a bodyguard unit', source: 'parser' }); continue; }
    for (const c of [...leaders, ...supports]) {
      const e = cat.findUnit(c.name, scope);
      if (!e) continue;
      const list = c.attachedAs === 'Leader' ? e.leads : e.supports;
      const same = (a: string, b: string) => { const x = norm(a); const y = norm(b); return x === y || x.endsWith(' ' + y) || y.endsWith(' ' + x); };
      if (!list.length) { issues.push({ severity: 'warning', code: 'bsdata-gap-association', unit: c.name, message: `BSData has no ${c.attachedAs} association for ${c.name}; cannot verify it may join ${body.name}`, source: 'bsdata' }); continue; }
      if (!list.some((x) => same(x, body.name)))
        issues.push({ severity: 'error', code: c.attachedAs === 'Leader' ? 'leader-target' : 'support-target', unit: c.name, message: `cannot ${c.attachedAs === 'Leader' ? 'lead' : 'support'} ${body.name}; BSData allows: ${list.join(', ') || '(none)'}`, source: 'bsdata' });
    }
  }

  // Pure Support characters (BSData Support link only, no Leader link) left unattached
  for (const u of r.units.filter((x) => x.attachGroup === null && !x.attachedAs)) {
    const e = cat.findUnit(u.name, scope);
    if (e && !e.leads.length && e.supports.length) issues.push({ severity: 'warning', code: 'support-unattached', unit: u.name, message: `${u.name} is a Support character (can attach to ${e.supports.join(', ')}) but is fielded alone`, source: 'bsdata' });
  }

  // Lee house rule: every CHARACTER must be attached (warning in the validator; HARD in the optimizer)
  if (opts.houseRules !== false) for (const u of r.units.filter((x) => x.attachGroup === null && !x.attachedAs)) {
    const e = cat.findUnit(u.name, scope);
    if (e && (e.keywords.some((k) => /^(character|leader)$/i.test(k)) || e.leads.length) && (e.leads.length || e.supports.length)) issues.push({ severity: 'warning', code: 'house-character-unattached', unit: u.name, message: `${u.name} is fielded unattached; Lee's house rule: no unattached characters`, source: 'house-rule' });
  }

  // Lee's Crusader loadout rule (only meaningful for his BT rosters)
  if (opts.houseRules !== false && /black templars/i.test(r.faction ?? '')) {
    for (const u of r.units.filter((x) => norm(x.name) === 'crusader squad')) {
      const ini = u.models.find((m) => /initiate/i.test(m.name));
      if (!ini) continue;
      // Lee's two kits are each built 7x Initiate Chainsword + 4x Power Fist. An 11-Initiate squad must match exactly;
      // a smaller squad must be a subset of that build (each count <= built, and every Initiate carries one of them). Subset rule for <11 Initiates: Lee-confirmed 2026-10-15.
      const built = Object.entries(LEE_RULES.crusaderInitiateLoadout);
      const total = built.reduce((s2, [, n]) => s2 + n, 0);
      const have = built.map(([w]) => [w, ini.wargear.filter((x) => norm(x.name) === norm(w)).reduce((s2, x) => s2 + x.count, 0)] as const);
      const sum = have.reduce((s2, [, n]) => s2 + n, 0);
      for (const [[w, want], [, h]] of built.map((x, i) => [x, have[i]!] as const)) {
        const bad = ini.count === total ? h !== want : h > want;
        if (bad) issues.push({ severity: 'error', code: 'house-initiate-loadout', unit: u.name, message: `Initiates have ${h}x ${w}; Lee's built loadout is ${want}${ini.count === total ? '' : ' (max, subset squad; Lee-confirmed)'}`, source: 'house-rule' });
      }
      if (sum !== ini.count) issues.push({ severity: 'error', code: 'house-initiate-loadout', unit: u.name, message: `${ini.count} Initiates but ${sum} carry a chainsword/power fist; Lee's build has one per Initiate`, source: 'house-rule' });
      const neo = u.models.filter((m) => /neophyte/i.test(m.name)).reduce((s, m) => s + m.count, 0);
      if (neo < 4) issues.push({ severity: 'error', code: 'house-min-neophytes', unit: u.name, message: `${neo} Neophytes; collection rule min 4`, source: 'house-rule' });
    }
  }

  // collection
  const col = opts.collection ?? null;
  if (col && col.status === 'loaded') {
    const need = new Map<string, { units: number; models: number; names: string[] }>();
    for (const u of r.units) {
      const k = norm(u.name);
      const cur = need.get(k) ?? { units: 0, models: 0, names: [] };
      cur.units += 1; cur.models += u.modelCount; cur.names.push(u.name);
      need.set(k, cur);
    }
    for (const [k, v] of need) {
      const owned = col.units.find((o) => norm(o.name) === k);
      const name = v.names[0]!;
      if (!owned) { issues.push({ severity: 'error', code: 'collection-not-owned', unit: name, message: `not in collection${col.notOwned.some((n) => norm(n).includes(k)) ? ' (listed under not_owned)' : ''}`, source: 'collection' }); continue; }
      if (v.units > owned.quantity && owned.modelsPerUnit <= 1)
        issues.push({ severity: 'error', code: 'collection-count', unit: name, message: `${v.units} fielded, ${owned.quantity} owned`, source: 'collection' });
      const cap = owned.name === SWORD_BRETHREN ? swordBrethrenCap(col.units, need.get(norm(CRUSADER_SQUAD))?.units ?? 0)! : owned.totalModels;
      if (owned.name === SWORD_BRETHREN && v.models > cap)
        issues.push({ severity: 'error', code: 'house-sword-brethren-cap', unit: name, message: `${v.models} Sword Brethren fielded; cap ${cap} = 10-model pool (${owned.totalModels} standalone + Crusader-kit Sword Brothers) minus ${need.get(norm(CRUSADER_SQUAD))?.units ?? 0} Crusader Squad(s) fielded (Lee's rule)`, source: 'house-rule' });
      else if (owned.name !== SWORD_BRETHREN && v.models > owned.totalModels)
        issues.push({ severity: 'error', code: 'collection-models', unit: name, message: `${v.models} models fielded, ${owned.totalModels} owned`, source: 'collection' });
    }
    for (const un of col.uncertain) {
      const words = norm(un.item).split(' ').filter((w) => w.length > 3);
      if (r.units.some((u) => words.some((w) => norm(u.name).includes(w))))
        issues.push({ severity: 'warning', code: 'collection-uncertain', message: `${un.item}: ${un.notes ?? ''}`.trim(), source: 'collection' });
    }
  } else if (col) {
    issues.push({ severity: 'warning', code: 'collection-missing', message: `collection ${col.status} at ${col.path}; ownership not checked`, source: 'collection' });
  }

  const pasted = r.units.reduce((s, u) => s + (u.pastedPts ?? 0), 0);
  const limit = opts.pointsLimit ?? (r.battleSize?.match(/\((\d[\d,]*)/)?.[1] ? Number(r.battleSize!.match(/\((\d[\d,]*)/)![1]!.replace(/,/g, '')) : null);
  if (limit !== null && bsComplete && bsTotal > limit) issues.push({ severity: 'error', code: 'over-limit', message: `BSData total ${bsTotal} > ${limit}`, source: 'bsdata' });
  if (limit !== null && pasted > limit) issues.push({ severity: 'warning', code: 'pasted-over-limit', message: `pasted total ${pasted} > ${limit}`, source: 'parser' });
  if (r.declaredPoints !== null && r.declaredPoints !== pasted) issues.push({ severity: 'info', code: 'declared-vs-sum', message: `header says ${r.declaredPoints}, unit lines sum to ${pasted}`, source: 'parser' });

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    totals: { pasted, bsdata: bsComplete ? bsTotal : null, declared: r.declaredPoints, limit },
    units, issues, collection: col ? { status: col.status, path: col.path } : null,
  };
}

const words = (x: string) => norm(x).split(' ').filter((w) => w.length > 2).map((w) => w.replace(/s$/, ''));

/** Pick the catalog model name that best matches a pasted model line (word overlap; sergeant/leader-aware). */
export function bestModel(line: string, names: string[]): string | null {
  const lw = new Set(words(line));
  const isLead = /sergeant|leader|exarch|champion|nob\b|boss|superior|pack leader/i.test(line);
  let best: string | null = null; let score = 0;
  for (const n of names) {
    let sc = words(n.replace(/\s+w\/.*$/i, '')).filter((w) => lw.has(w)).length;
    if (sc === 0) continue;
    const nLead = /sergeant|leader|exarch|champion|nob\b|boss|superior/i.test(n);
    if (nLead === isLead) sc += 0.5;
    if (sc > score) { score = sc; best = n; }
  }
  return best;
}

/**
 * Sum BSData wargear costs for a roster unit, scoping each item to the best-matching model entry.
 * Gear that cannot be tied to one BSData model entry (flattened pastes, unit-level gear, a pasted model name that matches none)
 * is ALLOCATED across the unit's BSData model entries that carry the item: at most one copy on a leader model (Sergeant etc.),
 * the rest on the other models, each copy priced at its own model's BSData cost. (Bug fix 2026-10-20: this path used to take the
 * max cost of the item over ALL model entries for every copy, e.g. Terminator Assault Squad 5x Thunder Hammer + 5x Storm Shield
 * priced 5x5 + 5x5 = 50 instead of the BSData 5 (Sergeant hammer) + 4x5 (shields) = 25, so 230 instead of 205 with Furious Assault.)
 * HEURISTIC (allocation only; every price is a BSData cost): leader models take at most one copy.
 */
export function wargearCost(u: RosterUnit, table: { model: string; item: string; pts: number }[]): number {
  let total = 0;
  const isLead = (n: string) => /sergeant|leader|exarch|champion|nob\b|boss|superior/i.test(n);
  const lines = [...u.models.map((m) => ({ model: m.name, gear: m.wargear })), { model: '', gear: u.unitWargear }];
  for (const l of lines) {
    for (const g of l.gear) {
      const cands = table.filter((t) => norm(t.item) === norm(g.name));
      if (!cands.length) continue;
      const n = Math.max(1, g.count);
      const bm = l.model ? bestModel(l.model, [...new Set(cands.map((c) => c.model))].filter(Boolean)) : null;
      if (bm) { total += Math.max(...cands.filter((c) => c.model === bm).map((c) => c.pts)) * n; continue; }
      const byModel = new Map<string, number>();
      for (const c of cands) byModel.set(c.model, Math.max(byModel.get(c.model) ?? 0, c.pts));
      if (byModel.size === 1) { total += [...byModel.values()][0]! * n; continue; }
      const lead = [...byModel].filter(([m]) => isLead(m)); const rank = [...byModel].filter(([m]) => !isLead(m));
      let left = n;
      if (lead.length && (!rank.length || u.modelCount > 1 || n === 1)) { total += lead[0]![1]; left--; }
      if (left > 0) total += (rank.length ? Math.min(...rank.map(([, p]) => p)) : Math.min(...lead.map(([, p]) => p))) * left;
    }
  }
  return total;
}
