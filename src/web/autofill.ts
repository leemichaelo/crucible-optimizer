/** Paste -> form auto-fill (pure): parse a pasted list with the roster parser and map it onto army / detachments / disposition / points / warlord. */
import type { CatalogIndex } from '../catalog/core.ts';
import { parseList } from '../roster/parse.ts';
import { norm } from '../bsdata/parse.ts';
import { DISPOSITIONS, detachmentsFor, MAX_DETACHMENTS } from '../select/selectionCore.ts';
import { classifyInput } from '../select/runCore.ts';

export interface AutoFill {
  kind: 'list' | 'collection' | 'empty';
  format: string | null;
  faction: string | null;
  /** Army as named in the page's army list, or null when the faction is not one of them. */
  army: string | null;
  detachments: string[];
  disposition: string | null;
  points: number | null;
  warlord: string | null;
  /** Problems or ambiguities to show next to the form; fields stay editable. */
  notices: string[];
}

const POINT_SIZES = [1000, 2000, 3000];

export function autofillFromText(cat: CatalogIndex, text: string, armies: string[]): AutoFill {
  const empty: AutoFill = { kind: 'empty', format: null, faction: null, army: null, detachments: [], disposition: null, points: null, warlord: null, notices: [] };
  if (!text.trim()) return empty;
  if (classifyInput(text) === 'collection') return { ...empty, kind: 'collection', notices: ['Collection JSON: used as the owned-model caps; the fields are not changed.'] };
  const out: AutoFill = { ...empty, kind: 'list' };
  let r;
  try { r = parseList(text, { catalog: cat, sourceFile: 'pasted text' }); } catch (e) { out.notices.push(`Could not parse the list (${(e as Error).message}); fill the fields by hand.`); return out; }
  out.format = r.format;
  // faction -> army: the most specific faction line that is one of the page's armies (chapter before "Space Marines")
  const lines = [...r.factionLines].reverse();
  out.faction = r.faction;
  out.army = lines.map((l) => armies.find((a) => norm(a) === norm(l))).find(Boolean) ?? null;
  if (!out.army) out.notices.push(r.faction ? `Faction "${r.faction}" is not in this site's army list (${armies.length} armies); army left unchanged.` : 'No faction line found in the paste; army left unchanged.');
  // detachments, validated against BSData for that army
  if (r.detachments.length) {
    const avail = out.army ? detachmentsFor(cat, out.army) : [];
    for (const d of r.detachments) {
      const hit = avail.find((x) => norm(x.name) === norm(d));
      if (hit) out.detachments.push(hit.name); else out.notices.push(`Detachment "${d}" ${out.army ? `is not a BSData detachment for ${out.army}` : 'could not be checked (unknown army)'}; left out.`);
    }
    if (out.detachments.length > MAX_DETACHMENTS) { out.notices.push(`${out.detachments.length} detachments listed; the page takes ${MAX_DETACHMENTS}. Extra ones dropped: ${out.detachments.slice(MAX_DETACHMENTS).join(', ')}.`); out.detachments = out.detachments.slice(0, MAX_DETACHMENTS); }
  } else out.notices.push('No detachment line found; detachment left unchanged.');
  // disposition / mission
  const m = r.mission ? DISPOSITIONS.find((x) => norm(x) === norm(r.mission!)) : undefined;
  if (m) out.disposition = m; else if (r.mission) out.notices.push(`"${r.mission}" is not a Force Disposition (${DISPOSITIONS.join(', ')}); disposition left unchanged.`);
  // points size: battle-size line first ("Strike Force (2,000 Points)"), else the list total rounded up to a game size
  const bs = r.battleSize?.match(/\(([\d,]+)\s*points?\)/i);
  if (bs) out.points = Number(bs[1]!.replace(/,/g, ''));
  else if (r.battleSize && /incursion/i.test(r.battleSize)) out.points = 1000;
  else if (r.battleSize && /strike force/i.test(r.battleSize)) out.points = 2000;
  else if (r.battleSize && /onslaught/i.test(r.battleSize)) out.points = 3000;
  else if (r.declaredPoints) { out.points = POINT_SIZES.find((p) => r.declaredPoints! <= p) ?? null; if (out.points) out.notices.push(`No battle-size line; points size ${out.points} inferred from the list total (${r.declaredPoints}).`); }
  // warlord
  const wl = r.units.filter((u) => u.warlord);
  if (wl.length === 1) out.warlord = wl[0]!.name;
  else if (wl.length > 1) out.notices.push(`${wl.length} units marked Warlord (${wl.map((u) => u.name).join(', ')}); warlord left empty.`);
  for (const w of r.warnings.filter((x) => !/^model count for/i.test(x)).slice(0, 3)) out.notices.push(`Parser: ${w}`);
  return out;
}
