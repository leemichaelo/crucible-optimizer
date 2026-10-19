/** Serialise a Roster as Warhammer 40,000 App style text (the layout parseGwText reads). */
import type { Roster, RosterUnit, WargearLine } from '../roster/types.ts';

const wg = (w: WargearLine[], ind: string) => w.map((x, i) => `${i === 0 ? `${ind}• ` : `${ind}  `}${x.count}x ${x.name}`);

function unitBlock(u: RosterUnit): string[] {
  const L = [`${u.name} (${u.pastedPts ?? 0} points)`];
  if (u.attachedAs) L.push(`• Attached as: ${u.attachedAs}${u.attachedAs === 'Bodyguard' ? '' : ' (Character)'}`);
  const ind = '  '; // App indents everything under the header by two spaces
  if (u.warlord) L.push(`${ind}• Warlord`);
  if (u.models.length > 1 || (u.models.length === 1 && u.models[0]!.wargear.length && u.modelCount > 1)) {
    for (const m of u.models) { L.push(`${ind}• ${m.count}x ${m.name}`); L.push(...wg(m.wargear, `${ind}  `)); }
  } else {
    const w = u.models[0]?.wargear.length ? u.models[0]!.wargear : u.unitWargear;
    L.push(...wg(w, ind));
  }
  if (u.enhancement) L.push(`${ind}• Enhancement: ${u.enhancement}`);
  return L;
}

export function toGwAppText(r: Roster): string {
  const total = r.units.reduce((s, u) => s + (u.pastedPts ?? 0), 0);
  const out = [`${r.name ?? 'Crucible list'} (${total} points)`, '', ...(r.factionLines.length ? r.factionLines : [r.faction ?? '']),
    r.detachments.join(' and '), ...(r.mission ? [r.mission] : []), r.battleSize ?? `Strike Force (2000 points)`, ''];
  const groups = [...new Set(r.units.filter((u) => u.attachGroup !== null).map((u) => u.attachGroup!))];
  if (groups.length) {
    out.push('Attached Units');
    groups.forEach((g, i) => { out.push(`Attached Unit ${i + 1}`, ''); for (const u of r.units.filter((x) => x.attachGroup === g)) out.push(...unitBlock(u), ''); });
  }
  for (const sec of ['CHARACTERS', 'BATTLELINE', 'DEDICATED TRANSPORTS', 'OTHER DATASHEETS']) {
    const us = r.units.filter((u) => u.attachGroup === null && (u.section ?? 'OTHER DATASHEETS').toUpperCase() === sec);
    if (!us.length) continue;
    out.push(sec, '');
    for (const u of us) out.push(...unitBlock(u), '');
  }
  out.push(`Exported with crucible-cli (data only; points from BSData)`);
  return out.join('\n');
}
