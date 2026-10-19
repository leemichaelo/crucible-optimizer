/**
 * Detachment stratagems. BSData has no stratagem entries, so these come from a SECONDARY source:
 * the Wahapedia 11th-edition Black Templars page. Pure: the stratagem file is passed in (stratagems.ts loads it in Node).
 */
export interface SourcedStratagem {
  name: string; cp: number; detachment: string; when: string; target: string; effect: string; restrictions: string | null;
  errata: string | null;
}
export interface StratagemFile {
  label: 'SECONDARY'; source: { url: string; snapshot: string; retrieved: string; note: string };
  detachments: Record<string, SourcedStratagem[]>;
}

export const WAHAPEDIA_BT_URL = 'https://wahapedia.ru/wh40k11ed/factions/space-marines/black-templars';

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/\s+([.,:;)\]’'])/g, '$1').replace(/([(\[‘])\s+/g, '$1').trim();

/** Parse the `pdftotext`-like text dump of the Wahapedia faction page (one token per line). */
export function parseStratagems(text: string): Record<string, SourcedStratagem[]> {
  const L = text.split('\n').map((x) => x.trim());
  const starts: number[] = [];
  for (let i = 0; i + 2 < L.length; i++) if (/^\d+CP$/.test(L[i + 1]!) && /^(.+) Stratagem$/.test(L[i + 2]!) && /^[A-Z0-9’'!,\- ]+$/.test(L[i]!)) starts.push(i);
  const out: Record<string, SourcedStratagem[]> = {};
  starts.forEach((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1]! : L.length;
    for (let j = s + 3; j < end; j++) if (/^(UNIQUE:|Detachment Rules|Enhancements)$/.test(L[j]!) || /^\d+DP$/.test(L[j + 1] ?? '')) { end = j; break; }
    const body = L.slice(s + 3, end);
    const errIdx = body.findIndex((x) => x === 'Errata');
    const main = clean(body.slice(0, errIdx < 0 ? body.length : errIdx).join(' '));
    const errata = errIdx < 0 ? null : clean(body.slice(errIdx + 1).join(' ').replace(/^Show /, ''));
    const sec = (key: string, next: string[]) => { const m = main.match(new RegExp(`${key}:\\s*(.*?)\\s*(?:${next.map((n) => `${n}:`).join('|')}|$)`)); return m ? clean(m[1]!) : ''; };
    const det = L[s + 2]!.replace(/ Stratagem$/, '');
    (out[det] ??= []).push({ name: L[s]!, cp: Number.parseInt(L[s + 1]!, 10), detachment: det, when: sec('WHEN', ['TARGET']), target: sec('TARGET', ['EFFECT']), effect: sec('EFFECT', ['RESTRICTIONS']), restrictions: sec('RESTRICTIONS', []) || null, errata });
  });
  return out;
}

/** Stratagems available to the chosen detachment(s) only. Unknown detachment -> empty list + flag. */
export function stratagemsFor(detachments: string[], f: StratagemFile | null) {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!f) return { label: 'UNAVAILABLE' as const, blocker: 'no stratagem file loaded (data/stratagems.json); run crucible import-strats', stratagems: [] as SourcedStratagem[], missing: detachments };
  const keys = Object.keys(f.detachments);
  const found = detachments.map((d) => keys.find((k) => n(k) === n(d)));
  return { label: f.label, source: f.source, stratagems: found.flatMap((k) => (k ? f.detachments[k]! : [])), missing: detachments.filter((_, i) => !found[i]) };
}

