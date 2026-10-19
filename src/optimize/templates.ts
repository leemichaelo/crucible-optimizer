import { LEE_RULES } from '../validate/houseRules.ts';
/**
 * Unit templates for the optimizer: one concrete RosterUnit per owned unit option.
 * Loadout source priority (recorded on each template):
 *   1. the user's own list export (real loadouts, default /workspace/codex-rebuild/lee-fist-export.txt)
 *   2. the collection's loadout text, when it names BSData weapons
 *   3. BSData default composition (minimum size, mandatory/default wargear)  -> labelled HEURISTIC
 */
import type { CatalogIndex } from '../catalog/core.ts';
import { norm } from '../bsdata/parse.ts';
import type { Roster, RosterUnit } from '../roster/types.ts';
import { emptyUnit } from '../roster/types.ts';
import type { Collection, OwnedUnit } from '../validate/collectionCore.ts';
import type { UnitEntry } from '../types.ts';

export interface Template {
  key: string;
  unit: RosterUnit;
  entry: UnitEntry;
  owned: OwnedUnit;
  isCharacter: boolean;
  loadoutSource: 'list-export' | 'collection-text' | 'bsdata-default';
  note: string | null;
}

function clone(u: RosterUnit): RosterUnit { return JSON.parse(JSON.stringify(u)); }

/** Weapons named in collection loadout text, e.g. "thunder hammer + storm shield (default); ...". First clause only. */
function collectionGear(o: OwnedUnit, e: UnitEntry): string[] {
  if (!o.loadout) return [];
  const first = o.loadout.split(/;|\(as in|\(default\)/i)[0]!;
  const names = [...new Set(e.weapons.map((w) => w.name.replace(/^➤\s*/, '').split(' - ')[0]!))];
  const extraNonWeapon = ['Storm Shield'];
  return [...names, ...extraNonWeapon].filter((n) => norm(first).includes(norm(n)));
}

export function buildTemplates(cat: CatalogIndex, col: Collection, faction: string, exportRoster: Roster | null, extraSizes: { name: string; models: number }[] = []): { templates: Template[]; notes: string[] } {
  const scope = cat.scope(faction);
  const notes: string[] = [];
  const out: Template[] = [];
  for (const o of col.units) {
    const e = cat.findUnit(o.name, scope);
    if (!e) { notes.push(`collection unit "${o.name}" not found in BSData; skipped`); continue; }
    const isCharacter = e.keywords.some((k) => /^character$/i.test(k)) || e.leads.length > 0; // Grimaldus' unit lacks the Character keyword in BSData but has Leader + leads: treated as a character for the no-unattached house rule
    const fromExport = exportRoster?.units.filter((u) => norm(u.name) === norm(e.name)) ?? [];
    const sizes = new Set<number>();
    if (fromExport.length) {
      for (const u of fromExport) {
        const t = clone(u); t.attachedAs = null; t.attachGroup = null; t.attachTarget = null; t.enhancement = null; t.enhancementPts = null; t.warlord = false; t.pastedPts = null; t.section = null;
        if (sizes.has(t.modelCount)) continue;
        sizes.add(t.modelCount);
        out.push({ key: `${e.name}#${t.modelCount}`, unit: t, entry: e, owned: o, isCharacter, loadoutSource: 'list-export', note: null });
      }
    }
    // additional size: full owned model count (per unit) when the datasheet allows it and differs from the export size
    const ownedSize = Math.min(o.modelsPerUnit, e.maxModels);
    const sizesWanted = [...new Set([e.minModels, ownedSize])].filter((n) => n >= e.minModels && n <= o.totalModels && !sizes.has(n));
    if (fromExport.length && sizesWanted.length && e.defaultLoadout.length) {
      // only add sizes the export does not cover, built from BSData defaults
    }
    for (const n of fromExport.length ? sizesWanted.filter((x) => x > Math.max(...sizes)) : sizesWanted.length ? sizesWanted : [e.minModels]) {
      const u = emptyUnit(e.name, null);
      const cg = collectionGear(o, e);
      let source: Template['loadoutSource'] = 'bsdata-default';
      if (e.defaultLoadout.length) {
        const total = e.defaultLoadout.reduce((s, m) => s + m.count, 0);
        // scale the most numerous model line up to the target size
        const lines = e.defaultLoadout.map((m) => ({ ...m }));
        const big = lines.reduce((a, b) => (b.count > a.count ? b : a));
        big.count += n - total;
        for (const m of lines) u.models.push({ name: m.model, count: m.count, wargear: (cg.length ? cg : m.wargear).map((w) => ({ name: w, count: m.count })) });
        if (cg.length) source = 'collection-text';
      }
      u.modelCount = n;
      out.push({ key: `${e.name}#${n}`, unit: u, entry: e, owned: o, isCharacter, loadoutSource: source,
        note: source === 'bsdata-default' ? `HEURISTIC loadout: BSData default composition${n !== e.minModels ? ` scaled to ${n} models` : ''}` : `loadout from collection text "${o.loadout}"` });
    }
  }
  // extra sizes requested by --lock 'Name xN@M': scale an existing template (HEURISTIC loadout; single-model lines such as sergeants kept)
  for (const x of extraSizes) {
    if (out.some((t) => norm(t.entry.name) === norm(x.name) && t.unit.modelCount === x.models)) continue;
    const src = out.find((t) => norm(t.entry.name) === norm(x.name) && t.unit.models.length);
    if (!src) { notes.push(`--lock size ${x.name}@${x.models}: no template to scale; skipped`); continue; }
    if (x.models < src.entry.minModels || x.models > src.entry.maxModels) { notes.push(`--lock size ${x.name}@${x.models}: outside BSData ${src.entry.minModels}-${src.entry.maxModels}; skipped`); continue; }
    const u = clone(src.unit); const fixed = u.models.filter((m) => m.count === 1); const flex = u.models.filter((m) => m.count > 1);
    const oldFlex = flex.reduce((a, m) => a + m.count, 0); const want = x.models - fixed.length;
    let given = 0;
    flex.forEach((m, k) => { const old = m.count; const nc = k === flex.length - 1 ? want - given : Math.round((old * want) / oldFlex); given += nc; m.count = nc; m.wargear = m.wargear.map((w) => ({ ...w, count: w.count === old ? nc : Math.max(0, Math.round((w.count * nc) / old)) })); });
    u.modelCount = x.models;
    out.push({ ...src, key: `${src.entry.name}#${x.models}`, unit: u, loadoutSource: src.loadoutSource, note: `HEURISTIC loadout: ${src.key} scaled to ${x.models} models (single-model lines kept, others proportional) for --lock` });
  }
  // Lee's house rule: Crusader Squad Initiates are built 7x Initiate Chainsword + 4x Power Fist. Enforce on every template.
  for (const t of out.filter((x) => norm(x.entry.name) === 'crusader squad')) {
    const ini = t.unit.models.find((m) => /initiate/i.test(m.name));
    if (!ini) continue;
    const want = Object.entries(LEE_RULES.crusaderInitiateLoadout);
    const need = want.reduce((s, [, n]) => s + n, 0);
    if (ini.count > need) { notes.push(`Crusader Squad template with ${ini.count} Initiates cannot carry Lee's ${need}-model loadout; dropped`); t.unit.modelCount = -1; continue; }
    // smaller squads: a subset of the 7/4 build summing to the Initiate count (Lee-confirmed); which subset is HEURISTIC (proportional)
    const pick = want.map(([n, c]) => [n, Math.round((c * ini.count) / need)] as [string, number]);
    const diff = ini.count - pick.reduce((a, [, c]) => a + c, 0); pick[0]![1] += diff;
    ini.wargear = ini.wargear.filter((w) => !want.some(([n]) => norm(n) === norm(w.name)));
    for (const [n, c] of pick) ini.wargear.push({ name: n, count: c });
    t.note = `${t.note ? `${t.note}; ` : ''}Initiate loadout enforced from ${LEE_RULES.source}`;
  }
  return { templates: out.filter((t) => t.unit.modelCount !== -1), notes };
}
