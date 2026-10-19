/**
 * List parsers: 40k App text, BCP text (flattened App paste), New Recruit tournament text, New Recruit/BattleScribe roster JSON.
 * Model-vs-wargear classification of "Nx Name" lines uses the BSData catalog where indentation/bullets are ambiguous.
 */
import type { CatalogIndex } from '../catalog/core.ts';
import { norm } from '../bsdata/parse.ts';
import type { ModelLine, Roster, RosterFormat, RosterUnit, WargearLine } from './types.ts';
import { emptyUnit } from './types.ts';

const SECTION = /^(attached units?|characters?|battleline|dedicated transports?|other datasheets|allied units?|fortifications?|epic heroes|infantry|vehicles|monsters|beasts|mounted|swarms?)$/i;
const UNIT_HDR = /^(?!•|◦|-)(.+?)\s*\((\d[\d,]*)\s*(?:points|pts)\)\s*$/i;
const COUNT_ITEM = /^(\d+)x\s+(.+?)\s*$/i;

function int(s: string): number { return Number(s.replace(/,/g, '')); }

export function detectFormat(text: string): RosterFormat {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'newrecruit-json';
  if (/^\s*(char\d+|\+\s*faction keyword|\+\+)/im.test(text) || /^\s*\d+x .+\(\d+ pts\):/im.test(text)) return 'newrecruit-text';
  if (/^Format inspected:|^CentAR|^ATTACHED UNITS$/m.test(text) || /\(\d[\d,]* Points\)/.test(text)) return 'bcp';
  if (/Exported with App Version|\(\d+ points\)/i.test(text)) return 'gw-app';
  return 'unknown';
}

export interface ParseOptions { catalog?: CatalogIndex; sourceFile?: string; }

export function parseList(text: string, opts: ParseOptions = {}): Roster {
  const fmt = detectFormat(text);
  let r: Roster;
  if (fmt === 'newrecruit-json') r = parseRosterJson(text);
  else if (fmt === 'newrecruit-text') r = parseNewRecruitText(text);
  else r = parseGwText(text, fmt === 'unknown' ? 'gw-app' : fmt, opts.catalog);
  r.sourceFile = opts.sourceFile ?? null;
  for (const u of r.units) finalizeUnit(u, r, opts.catalog);
  return r;
}

function baseRoster(format: RosterFormat): Roster {
  return { format, sourceFile: null, name: null, player: null, faction: null, factionLines: [], detachments: [], mission: null, battleSize: null, declaredPoints: null, units: [], warnings: [] };
}

/** Ensure modelCount, and fall back to catalog min size for single-model units. */
function finalizeUnit(u: RosterUnit, r: Roster, cat?: CatalogIndex): void {
  u.modelCount = u.models.reduce((s, m) => s + m.count, 0);
  if (u.modelCount === 0) {
    const entry = cat?.findUnit(u.name, cat.scope(r.faction ?? undefined));
    u.modelCount = entry ? entry.minModels : 1;
    if (!entry) r.warnings.push(`model count for "${u.name}" unknown (no model lines, not in catalog); assumed 1`);
  }
}

// ---------------- GW / BCP text ----------------

interface Ctx { cat?: CatalogIndex; scope: string[]; }

function isWeaponName(ctx: Ctx, unitName: string, item: string): boolean | null {
  if (!ctx.cat) return null;
  const e = ctx.cat.findUnit(unitName, ctx.scope);
  if (!e) return null;
  const n = norm(item);
  if (e.weapons.some((w) => { const wn = norm(w.name.replace(/^➤\s*/, '').split(' - ')[0]!); return wn === n; })) return true;
  const same = (a: string) => { const x = norm(a.replace(/\s+w\/.*$/i, '')); return x === n || x + 's' === n || n + 's' === x || x.replace(/ies$/, 'y') === n.replace(/ies$/, 'y'); };
  if (e.profiles.some((p) => same(p.name)) || (e.modelNames ?? []).some(same)) return false;
  return null;
}

/** false when the catalog knows the unit and the item shares no word with any of its model/profile names. */
function plausibleModel(ctx: Ctx, unitName: string, item: string): boolean | null {
  if (!ctx.cat) return null;
  const e = ctx.cat.findUnit(unitName, ctx.scope);
  if (!e) return null;
  const words = (x: string) => norm(x).split(' ').filter((w) => w.length > 3).map((w) => w.replace(/s$/, ''));
  const iw = new Set(words(item));
  const pool = [e.name, ...e.modelNames, ...e.profiles.map((p) => p.name)].flatMap(words);
  return pool.some((w) => iw.has(w));
}

export function parseGwText(text: string, format: RosterFormat, cat?: CatalogIndex): Roster {
  const r = baseRoster(format);
  const lines = text.replace(/\r/g, '')
    .replace(/\(([^()\n]*)\n\s*([^()\n]*\))/g, '($1 $2')
    .split('\n')
    .filter((l) => !/^\s*Uploaded with\b/i.test(l));
  const ctx: Ctx = { cat, scope: [] };
  let i = 0;
  // header
  const header: string[] = [];
  for (; i < lines.length; i++) {
    const raw = lines[i]!; const l = raw.trim();
    if (!l) continue;
    if (SECTION.test(l) || /^attached unit \d+$/i.test(l)) break;
    if (/^Format inspected:/i.test(l)) continue;
    // a unit header followed by bullets means the body started
    const next = lines.slice(i + 1).find((x) => x.trim())?.trim() ?? '';
    if (UNIT_HDR.test(l) && /^[•◦]/.test(next)) break;
    header.push(l);
  }
  const titleIdx = header.findIndex((l) => UNIT_HDR.test(l));
  if (titleIdx >= 0) {
    const m = header[titleIdx]!.match(UNIT_HDR)!;
    r.name = m[1]!.trim(); r.declaredPoints = int(m[2]!);
    if (titleIdx >= 1) r.player = header[titleIdx - 1]!;
    for (const l of header.slice(titleIdx + 1)) {
      if (/detachment points?\)/i.test(l)) r.detachments = l.replace(/\s*\(\d+ detachment points?\)/i, '').split(/,?\s+and\s+|\s*\+\s*|,\s*/).map((x) => x.trim()).filter(Boolean);
      else if (/^(strike force|incursion|onslaught|combat patrol)/i.test(l)) r.battleSize = l;
      else if (!r.detachments.length && cat && knownDetachments(cat, l)) r.detachments = knownDetachments(cat, l)!;
      else if (!r.detachments.length) r.factionLines.push(l);
      else if (!r.mission) r.mission = l;
    }
  } else r.warnings.push('no roster title line with points found');
  r.faction = r.factionLines[r.factionLines.length - 1] ?? null;
  if (cat) ctx.scope = cat.scope(r.faction ?? undefined);

  const hollow = lines.some((l) => l.trim().startsWith('◦'));
  let section: string | null = null;
  let group: number | null = null;
  let cur: RosterUnit | null = null;
  let curModel: ModelLine | null = null;
  const push = () => { if (cur) r.units.push(cur); cur = null; curModel = null; };

  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const l = raw.trim();
    if (!l) continue;
    if (/^Exported with/i.test(l)) continue;
    if (SECTION.test(l)) { push(); section = l.toUpperCase(); if (!/attached/i.test(l)) group = null; continue; }
    let m = l.match(/^attached unit (\d+)$/i);
    if (m) { push(); group = Number(m[1]); continue; }
    m = l.match(UNIT_HDR);
    if (m && !/^[•◦]/.test(l)) {
      push();
      cur = emptyUnit(m[1]!.trim(), int(m[2]!));
      cur.section = section; cur.attachGroup = section && /attached/i.test(section) ? group : null;
      continue;
    }
    if (!cur) { r.warnings.push(`unparsed line outside unit: "${l}"`); continue; }
    const u: RosterUnit = cur;
    const bullet = l.match(/^([•◦])\s*/);
    const body = l.replace(/^[•◦]\s*/, '');
    const indent = raw.match(/^\s*/)![0].length;
    m = body.match(/^attached as:\s*(leader|support|bodyguard)/i);
    if (m) { u.attachedAs = (m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase()) as RosterUnit['attachedAs']; continue; }
    if (/^warlord$/i.test(body)) { u.warlord = true; continue; }
    m = body.match(/^enhancements?:\s*(.+?)(?:\s*\(\+?(\d+)\s*(?:pts|points)\))?$/i);
    if (m) { u.enhancement = m[1]!.trim(); u.enhancementPts = m[2] ? Number(m[2]) : null; continue; }
    if (/^[A-Za-z' ]+:\s*\S/.test(body) && !COUNT_ITEM.test(body)) { u.unitWargear.push({ name: body, count: 0 }); r.warnings.push(`kept option line in ${u.name}: "${body}"`); continue; }
    m = body.match(COUNT_ITEM);
    if (!m) { r.warnings.push(`unparsed line in ${u.name}: "${l}"`); continue; }
    const item: WargearLine = { name: m[2]!.trim(), count: Number(m[1]) };
    // New Recruit (v36.x) sometimes prints an enhancement as a plain "1x <Enhancement>" line on a character instead of
    // "Enhancements: <name>". If the name is a BSData enhancement (of a detachment in this roster when known) and not
    // one of the unit's weapons, record it as the enhancement so its points are counted.
    if (item.count === 1 && !u.enhancement && ctx.cat && isWeaponName(ctx, u.name, item.name) !== true) {
      const dets = new Set(r.detachments.map(norm));
      const hits = ctx.cat.cat.enhancements.filter((e) => norm(e.name) === norm(item.name));
      const hit = hits.find((e) => dets.has(norm(e.detachment))) ?? (dets.size ? undefined : hits[0]);
      if (hit) { u.enhancement = hit.name; u.enhancementPts = null; r.warnings.push(`${u.name}: "1x ${item.name}" read as enhancement (${hit.detachment})`); continue; }
    }
    // classify
    let isModel: boolean;
    const w = isWeaponName(ctx, u.name, item.name);
    if (w === true) isModel = false;
    else if (w === false) isModel = true;
    else if (plausibleModel(ctx, u.name, item.name) === false) isModel = false;
    else if (bullet?.[1] === '◦') isModel = false;
    else if (format === 'bcp' && hollow) isModel = !!bullet; // BCP with ◦ markers: • = model
    else if (format === 'bcp' && bullet) isModel = /^[•◦]/.test((lines.slice(i + 1).find((x) => x.trim()) ?? '').trim()) && !/^(•\s*)?(attached as|warlord|enhancement)/i.test((lines.slice(i + 1).find((x) => x.trim()) ?? '').trim());
    else if (format === 'gw-app') isModel = !!bullet && indent === 2; // App: models at "  • ", wargear deeper
    else isModel = !!bullet && curModel === null && u.unitWargear.length === 0 && /\b(sergeant|champion|brother|veteran|marine|terminator)s?\b/i.test(item.name);
    if (isModel) { curModel = { name: item.name, count: item.count, wargear: [] }; u.models.push(curModel); }
    else if (curModel) (curModel as ModelLine).wargear.push(item);
    else u.unitWargear.push(item);
  }
  push();
  return r;
}

// ---------------- New Recruit tournament text ----------------
// e.g. "Char3: 1x Crusade Ancient (60 pts): Bolt pistol, Master-crafted Power Weapon, Enhancement: Warden of Honour (+20 pts)"
//      "5x Assault Intercessor Squad (75 pts): 1x Assault Intercessor Sergeant: Plasma pistol, Astartes Chainsword; 4x Assault Intercessors: 4 with Astartes Chainsword, Heavy Bolt Pistol"
const NR_UNIT = /^(?:[a-z]+\d+:\s*)?(\d+)x\s+(.+?)\s*[\(\[](\d+)\s*pts[\)\]]\s*:?\s*(.*)$/i;

export function parseNewRecruitText(text: string): Roster {
  const r = baseRoster('newrecruit-text');
  let cur: RosterUnit | null = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const l = raw.trim().replace(/^[+\s]+/, '');
    if (!l) continue;
    let m = l.match(/^faction keyword:\s*(.+)$/i);
    if (m) { r.factionLines = m[1]!.split(/\s+-\s+/); r.faction = r.factionLines[r.factionLines.length - 1]!.trim(); continue; }
    if ((m = l.match(/^detachments?:\s*(.+)$/i))) { r.detachments = m[1]!.split(/[;,]|\s+and\s+/).map((x) => x.replace(/\(.*\)/, '').trim()).filter(Boolean); continue; }
    if ((m = l.match(/^total army points:\s*(\d+)/i))) { r.declaredPoints = Number(m[1]); continue; }
    if ((m = l.match(/^force disposition:\s*(.+)$/i))) { r.mission = m[1]!.trim(); continue; }
    if ((m = l.match(/^warlord:\s*(?:[a-z]+\d+:\s*)?(.+)$/i))) { const nm = m[1]!.trim(); const u = r.units.find((x) => x.name === nm); if (u) u.warlord = true; continue; }
    m = l.match(NR_UNIT);
    if (m) {
      cur = emptyUnit(m[2]!.trim(), Number(m[3]));
      const total = Number(m[1]);
      parseNrBody(cur, m[4] ?? '', total);
      r.units.push(cur);
      continue;
    }
    if (cur && /^[•\-]/.test(l)) parseNrBody(cur, l.replace(/^[•\-]\s*/, ''), 0);
  }
  return r;
}

function parseNrBody(u: RosterUnit, body: string, total: number): void {
  for (const seg of body.split(/;\s*/)) {
    const s = seg.trim();
    if (!s) continue;
    let m = s.match(/^(leading|supporting|attached to)\s+(.+)$/i);
    if (m) { if (/attached/i.test(m[1]!)) { u.attachedAs = 'Bodyguard'; continue; } u.attachTarget = m[2]!.replace(/\[\d+\]$/, '').trim(); u.attachedAs = /leading/i.test(m[1]!) ? 'Leader' : 'Support'; continue; }
    m = s.match(/^(\d+)x\s+([^:]+):\s*(.*)$/);
    if (m) { u.models.push({ name: m[2]!.trim(), count: Number(m[1]), wargear: splitGear(m[3]!, Number(m[1])) }); continue; }
    for (const g of splitGear(s, 1, u)) u.unitWargear.push(g);
  }
  if (total && !u.models.length) u.models.push({ name: u.name, count: total, wargear: u.unitWargear.splice(0) });
}

function splitGear(s: string, models: number, u?: RosterUnit): WargearLine[] {
  const out: WargearLine[] = [];
  for (let part of s.split(/,\s*(?![^()]*\))/)) {
    part = part.trim();
    if (!part) continue;
    let m = part.match(/^enhancement:\s*(.+?)(?:\s*\(\+?(\d+)\s*pts\))?$/i);
    if (m) { if (u) { u.enhancement = m[1]!.trim(); u.enhancementPts = m[2] ? Number(m[2]) : null; } continue; }
    if (/^warlord$/i.test(part)) { if (u) u.warlord = true; continue; }
    m = part.match(/^(\d+)\s*(?:x|with)\s+(.+)$/i);
    if (m) out.push({ name: m[2]!.trim(), count: Number(m[1]) });
    else out.push({ name: part, count: models });
  }
  return out;
}

// ---------------- New Recruit / BattleScribe roster JSON ----------------
type J = any;
export function parseRosterJson(text: string): Roster {
  const r = baseRoster('newrecruit-json');
  const d = JSON.parse(text);
  const roster = d.roster ?? d;
  r.name = roster.name ?? null;
  const ptsOf = (o: J) => Number((o.costs ?? []).find((c: J) => /^pts$/i.test(c.name ?? '') || c.typeId === '51b2-306e-1021-d207')?.value ?? 0);
  const total = (o: J): number => ptsOf(o) * 1 + (o.selections ?? []).reduce((s: number, x: J) => s + total(x), 0);
  r.declaredPoints = (roster.costLimits ?? []).find((c: J) => /pts/i.test(c.name ?? ''))?.value ?? null;
  for (const f of roster.forces ?? []) {
    r.faction = r.faction ?? (f.catalogueName ?? null);
    if (r.faction) r.factionLines = String(r.faction).split(/\s+-\s+/);
    r.faction = r.factionLines[r.factionLines.length - 1] ?? r.faction;
    for (const s of f.selections ?? []) {
      const cats = (s.categories ?? []).map((c: J) => String(c.name));
      if (/detachment/i.test(s.name) || cats.some((c: string) => /configuration/i.test(c))) {
        for (const x of s.selections ?? []) if (x.name) r.detachments.push(x.name);
        continue;
      }
      if (s.type !== 'unit' && s.type !== 'model') continue;
      const u = emptyUnit(s.name, total(s));
      const visit = (o: J, model: ModelLine | null) => {
        for (const x of o.selections ?? []) {
          const isEnh = (x.costs ?? []).some((c: J) => /enhancement/i.test(c.name ?? '') && Number(c.value) >= 1) || (x.group ?? '').match(/enhancement/i);
          if (isEnh) { u.enhancement = x.name; u.enhancementPts = ptsOf(x); continue; }
          if (/^warlord$/i.test(x.name)) { u.warlord = true; continue; }
          if (x.type === 'model') { const ml: ModelLine = { name: x.name, count: Number(x.number ?? 1), wargear: [] }; u.models.push(ml); visit(x, ml); }
          else if (x.type === 'upgrade') { const g = { name: x.name, count: Number(x.number ?? 1) }; (model ? model.wargear : u.unitWargear).push(g); visit(x, model); }
          else visit(x, model);
        }
      };
      if (s.type === 'model') { const ml: ModelLine = { name: s.name, count: Number(s.number ?? 1), wargear: [] }; u.models.push(ml); visit(s, ml); }
      else visit(s, null);
      r.units.push(u);
    }
  }
  return r;
}

/** Group attached units: returns arrays of units forming one battlefield unit. */
export function attachedGroups(r: Roster): RosterUnit[][] {
  const out: RosterUnit[][] = [];
  const byGroup = new Map<number, RosterUnit[]>();
  const used = new Set<RosterUnit>();
  for (const u of r.units) if (u.attachGroup !== null) { (byGroup.get(u.attachGroup) ?? byGroup.set(u.attachGroup, []).get(u.attachGroup)!).push(u); used.add(u); }
  // New Recruit: attachTarget
  for (const u of r.units) {
    if (!u.attachTarget || used.has(u)) continue;
    const tgt = r.units.find((x) => !used.has(x) && x !== u && norm(x.name) === norm(u.attachTarget!) && x.attachTarget === null)
      ?? r.units.find((x) => x !== u && norm(x.name) === norm(u.attachTarget!));
    if (!tgt) continue;
    const g = out.find((gg) => gg.includes(tgt));
    if (g) g.push(u); else { out.push([tgt, u]); used.add(tgt); }
    used.add(u);
  }
  out.push(...byGroup.values());
  for (const u of r.units) if (!used.has(u)) out.push([u]);
  return out;
}

/** A header line with no "(N Detachment Points)" suffix whose every part is a detachment name known to BSData enhancements. */
function knownDetachments(cat: CatalogIndex, l: string): string[] | null {
  const parts = l.split(/,?\s+and\s+|\s*\+\s*|,\s*/).map((x) => x.trim()).filter(Boolean);
  const known = new Set(cat.cat.enhancements.map((e) => norm(e.detachment)));
  return parts.length && parts.every((p) => known.has(norm(p))) ? parts : null;
}
