/** Page script: form <-> worker. All computation happens in worker.ts (a Web Worker), so the page never freezes. */
import { DISPOSITIONS } from '../src/select/selectionCore.ts';
import type { RunRequest } from './types.ts';
import { EXCLUDE_PRESETS } from '../src/select/excludes.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const army = $<HTMLSelectElement>('army'), det = $<HTMLSelectElement>('detachment'), det2 = $<HTMLSelectElement>('detachment2'), det3 = $<HTMLSelectElement>('detachment3'), disp = $<HTMLSelectElement>('disposition');
const runBtn = $<HTMLButtonElement>('run'), status = $('status'), prog = $('progress'), bar = $<HTMLProgressElement>('bar'), phase = $('phase'), elapsed = $('elapsed');
const out = $('out'), best = $<HTMLTextAreaElement>('best'), summary = $('summary'), took = $('took'), gaps = $('gaps');
let dets: { name: string; dispositions: string[]; dp: number | null }[] = [];
let running = false; let t0 = 0; let timer = 0; let lastFrac = 0;

// ---- unit exclude list (checkboxes + saved presets), persisted in localStorage ----
const EX_KEY = 'crucible-optimizer.exclude.v1';
const exBox = $('excl'), exPreset = $<HTMLSelectElement>('exPreset');
for (const p of EXCLUDE_PRESETS) exPreset.add(new Option(`${p.name} (${p.units.length} units)`, p.name));
type ExState = { preset: string; units: string[] };
const loadEx = (): ExState => { try { const v = JSON.parse(localStorage.getItem(EX_KEY) ?? 'null') as ExState | null; if (v && Array.isArray(v.units)) return v; } catch { /* none saved */ } return { preset: '', units: [] }; };
let exState = loadEx();
const saveEx = () => { try { localStorage.setItem(EX_KEY, JSON.stringify(exState)); } catch { /* private mode */ } };
function renderEx(names: string[]) {
  const all = [...new Set([...names, ...exState.units])].sort((a, b) => a.localeCompare(b));
  exBox.replaceChildren(...all.map((n) => { const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.value = n; c.checked = exState.units.includes(n);
    c.onchange = () => { exState = { preset: '', units: [...exBox.querySelectorAll<HTMLInputElement>('input:checked')].map((x) => x.value) }; exPreset.value = ''; saveEx(); }; l.append(c, ' ' + n); return l; }));
  exPreset.value = exState.preset;
}
let exNames: string[] = [];
$('exApply').onclick = () => { const p = EXCLUDE_PRESETS.find((x) => x.name === exPreset.value); exState = { preset: p?.name ?? '', units: p ? [...p.units] : [] }; saveEx(); renderEx(exNames); };
$('exClear').onclick = () => { exState = { preset: '', units: [] }; saveEx(); renderEx(exNames); };
renderEx([]);

for (const d of DISPOSITIONS) disp.add(new Option(d, d));
disp.value = 'Purge the Foe';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.postMessage({ type: 'init', dataUrl: new URL('data/', document.baseURI).href });

function fillDetachments() {
  const keep1 = det.value, keep2 = det2.value, keep3 = det3.value;
  det.replaceChildren(new Option('all (rank each that grants the disposition; slow)', 'all'));
  det2.replaceChildren(new Option('(none)', '')); det3.replaceChildren(new Option('(none)', ''));
  for (const d of dets) { const label = `${d.name} [${d.dispositions.join(', ') || 'no disposition in BSData'}${d.dp !== null ? `; ${d.dp} DP` : ''}]`; det.add(new Option(label, d.name)); det2.add(new Option(label, d.name)); det3.add(new Option(label, d.name)); }
  det.value = dets.some((d) => d.name === keep1) ? keep1 : (dets.find((d) => /vow-sworn/i.test(d.name))?.name ?? dets[0]?.name ?? 'all');
  det2.value = dets.some((d) => d.name === keep2) ? keep2 : '';
  det3.value = dets.some((d) => d.name === keep3) ? keep3 : '';
  if (pendingFill) applyFill(pendingFill);
  hint();
}
// ---- paste -> auto-fill (parsed in the worker with the roster parser) ----
type Fill = { kind: string; army: string | null; detachments: string[]; disposition: string | null; points: number | null; warlord: string | null; notices: string[]; faction?: string | null; format?: string | null; source?: string | null };
let pendingFill: Fill | null = null; let parseSeq = 0; let parseTimer = 0;
const note = $('parsenote');
function showNote(lines: string[], ok: string) { note.hidden = !lines.length && !ok; note.textContent = [ok, ...lines].filter(Boolean).join(' '); note.className = lines.length ? 'hint warn' : 'hint'; }
function applyFill(f: Fill) {
  pendingFill = null;
  const [a, b, c] = f.detachments;
  if (a) { det.value = a; det2.value = b ?? ''; det3.value = c ?? ''; }
  if (f.disposition) disp.value = f.disposition;
  if (f.points) { const ps = $<HTMLSelectElement>('points'); if ([...ps.options].some((o) => Number(o.value) === f.points)) ps.value = String(f.points); else f.notices.push(`Points size ${f.points} is not one of 1000/2000/3000; left unchanged.`); }
  $<HTMLInputElement>('warlord').value = f.warlord ?? '';
  hint();
  showNote(f.notices, `Auto-filled from the pasted ${f.source ? `${f.source} list` : 'list'}: ${[f.army, f.detachments.join(' + '), f.disposition, f.points, f.warlord ? `Warlord ${f.warlord}` : null].filter(Boolean).join(' · ')}.`);
}
function onFill(f: Fill) {
  if (f.kind === 'empty') { showNote([], ''); return; }
  if (f.kind !== 'list') { showNote(f.notices, ''); return; }
  if (f.army && f.army !== army.value) { pendingFill = f; army.value = f.army; army.onchange!(new Event('change')); return; } // load that faction's shards, then fill
  applyFill(f);
}
$<HTMLTextAreaElement>('input').addEventListener('input', () => { window.clearTimeout(parseTimer); parseTimer = window.setTimeout(() => worker.postMessage({ type: 'parse', text: $<HTMLTextAreaElement>('input').value, seq: ++parseSeq }), 300); });
function hint() {
  const chosen = [det.value, det2.value, det3.value].filter((x) => x && x !== 'all');
  const dp = chosen.reduce((s, n) => s + (dets.find((d) => d.name === n)?.dp ?? 0), 0);
  const dpMax = ({ 1000: 2, 2000: 3, 3000: 4 } as Record<string, number>)[$<HTMLSelectElement>('points').value] ?? 3;
  const grants = new Set(chosen.flatMap((n) => dets.find((d) => d.name === n)?.dispositions ?? []));
  $('dethint').textContent = det.value === 'all' ? 'Each detachment that grants the disposition is optimized and ranked (several minutes each).'
    : `${chosen.join(' + ')} grants: ${[...grants].join(', ') || 'none'}${grants.has(disp.value) ? '' : ` (not ${disp.value}: the run will be refused)`}. Several: disposition valid if granted by any; ${dp} of ${dpMax} Detachment Points${dp > dpMax ? ' (TOO MANY: the run will be refused)' : ''}.`;
}
det.onchange = det2.onchange = det3.onchange = disp.onchange = hint; $<HTMLSelectElement>('points').onchange = hint;
army.onchange = () => { runBtn.disabled = true; det.disabled = det2.disabled = det3.disabled = true; status.textContent = `Loading ${army.value}…`; worker.postMessage({ type: 'loadArmy', army: army.value }); };
$<HTMLInputElement>('dedOn').onchange = () => { $<HTMLInputElement>('ded').disabled = !$<HTMLInputElement>('dedOn').checked; };

$('f').onsubmit = (e) => {
  e.preventDefault(); if (running) return;
  const req: RunRequest = { army: army.value, detachment: det.value, detachment2: det.value === 'all' ? '' : det2.value, detachment3: det.value === 'all' ? '' : det3.value, points: Number($<HTMLSelectElement>('points').value) || 2000, warlord: $<HTMLInputElement>('warlord').value, exclude: [...exState.units], disposition: disp.value, input: $<HTMLTextAreaElement>('input').value,
    minDedicatedTankKillers: $<HTMLInputElement>('dedOn').checked ? Math.max(1, Number($<HTMLInputElement>('ded').value) || 2) : 0,
    minBandUnits: Math.max(0, Number($<HTMLInputElement>('band').value) || 0), bandThreshold: Math.max(1, Number($<HTMLInputElement>('bandPts').value) || 80), beamWidth: Math.max(5, Number($<HTMLInputElement>('beam').value) || 80) };
  running = true; lastFrac = 0; $('eta').textContent = 'ETA estimating…'; runBtn.disabled = true; prog.hidden = false; bar.removeAttribute('value'); phase.textContent = 'starting'; status.textContent = 'Running in a Web Worker…';
  t0 = performance.now(); timer = window.setInterval(() => { elapsed.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 200);
  worker.postMessage({ type: 'run', req });
};

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
worker.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'ready') {
    $('commit').textContent = m.manifest.source.commit.slice(0, 7);
    $('commitDate').textContent = String(m.manifest.source.commitDate).slice(0, 10);
    army.replaceChildren(...m.manifest.armies.map((a: string) => new Option(a, a)));
    army.value = m.manifest.defaultArmy; army.disabled = false; army.onchange!(new Event('change'));
  } else if (m.type === 'army') {
    exNames = m.excludable ?? []; renderEx(exNames);
    dets = m.detachments; det.disabled = det2.disabled = det3.disabled = false; fillDetachments(); runBtn.disabled = running;
    status.textContent = `${m.army}: ${m.units} BSData units loaded in ${(m.loadMs / 1000).toFixed(1)} s. Ready.`;
  } else if (m.type === 'parsed') {
    if (m.seq === parseSeq) onFill(m.fill as Fill);
  } else if (m.type === 'progress') {
    const p = m.p;
    const frac = p.phase === 'cells' ? 0.05 + 0.75 * (p.done / Math.max(1, p.total)) : p.phase === 'search' ? 0.8 + 0.15 * Math.min(1, p.done / Math.max(1, p.total)) : p.phase === 'validate' ? 0.96 : p.phase === 'done' ? 1 : 0.02;
    bar.max = 100; bar.value = Math.round(100 * ((p.run - 1) + frac) / p.runs);
    // ETA: elapsed time scaled by the remaining share (HEURISTIC: the cell phase dominates and runs at a steady rate)
    const tot = ((p.run - 1) + frac) / p.runs; const el = (performance.now() - t0) / 1000;
    if (tot > lastFrac) lastFrac = tot;
    $('eta').textContent = lastFrac >= 0.08 && lastFrac < 1 ? `ETA ~${fmtS(el * (1 - lastFrac) / lastFrac)} left` : lastFrac >= 1 ? 'finishing' : 'ETA estimating…';
    phase.textContent = `${p.runs > 1 ? `[${p.run}/${p.runs}] ` : ''}${p.detachments.join(' + ')}: ${p.message}`;
  } else if (m.type === 'result') {
    finish();
    out.hidden = false; best.value = m.bestTxt; took.textContent = `(${(m.elapsedMs / 1000).toFixed(1)} s in this browser${m.summary.cache.entriesBefore ? `, ${m.summary.cache.entriesBefore} cached cells reused` : ''})`;
    const s = m.summary;
    summary.innerHTML = m.feasible
      ? `<p class="ok">Best list: ${esc(s.detachments.join(' + '))} · ${esc(s.disposition)} · ${s.points} pts · score ${s.score} (HEURISTIC)</p>
         <p>Dedicated tank killers: ${esc(s.dedicatedTankKillers.join('; ') || 'none')}<br>Enhancements: ${esc(s.enhancements.join('; ') || 'none')}${s.ranking.length > 1 ? `<br>Ranking: ${esc(s.ranking.map((r: { detachments: string; bestScore: number | null }) => `${r.detachments} ${r.bestScore ?? 'n/a'}`).join(' · '))}` : ''}${s.inputNote.length ? `<br>${esc(s.inputNote.join('; '))}` : ''}</p>`
      : `<p class="bad">No list meets every hard rule.\n${esc(s.infeasible)}</p>`;
    renderBaseline(s.baselines ?? []);
    $('pool').textContent = [s.pool, s.excluded?.length ? `Excluded: ${s.excluded.join(', ')}.` : ''].filter(Boolean).join(' ');
    renderTop(s.top ?? []);
    gaps.textContent = [...s.gaps, ...(s.skipped.length ? [`Skipped (do not grant ${s.disposition}): ${s.skipped.join(', ')}`] : [])].join('\n');
    status.textContent = 'Done.';
    out.scrollIntoView({ behavior: 'smooth' });
  } else if (m.type === 'error') {
    finish(); status.textContent = ''; out.hidden = false; summary.innerHTML = `<p class="bad">${esc(m.message)}</p>`; best.value = ''; took.textContent = '';
  }
};
const fmtS = (x: number) => x >= 90 ? `${Math.round(x / 60)} min` : `${Math.max(1, Math.round(x))} s`;
type Baseline = { detachments: string; name: string; score: number; points: number; feasible: boolean; failing: string[] };
function renderBaseline(b: Baseline[]) {
  const el = $('baseline'); el.hidden = !b.length;
  el.innerHTML = b.map((x) => `<div>Pasted baseline <b>${esc(x.name)}</b> [${esc(x.detachments)}]: score <b>${x.score}</b> (HEURISTIC) · ${x.points} pts · ${x.feasible ? '<span class="pass">PASSES every hard rule</span>' : `<span class="fail">FAILS ${x.failing.length} hard rule${x.failing.length === 1 ? '' : 's'}</span><ul>${x.failing.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`}</div>`).join('');
}
type Top = { rank: number; detachments: string; score: number; points: number; units: number; unitList: string[]; enhancements: string[]; text: string };
function download(name: string, text: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function renderTop(t: Top[]) {
  const tb = $('top').querySelector('tbody')!;
  tb.replaceChildren(...t.map((x) => { const tr = document.createElement('tr');
    tr.innerHTML = `<td>${x.rank}</td><td>${x.score}</td><td>${x.points}</td><td title="${esc(x.unitList.join('\n'))}">${x.units}<br><span class="muted">${esc(x.unitList.join('; '))}</span></td><td>${esc(x.enhancements.join('; ') || 'none')}</td><td>${esc(x.detachments)}</td><td></td>`;
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Download'; b.onclick = () => download(`list-${x.rank}.txt`, x.text); tr.lastElementChild!.append(b); return tr; }));
  $('top').hidden = !t.length;
  $('topnote').textContent = t.length < 10 ? `Only ${t.length} distinct list${t.length === 1 ? '' : 's'} met every hard rule in this search (lists that differ only in enhancement placement are folded into one row; try a wider beam for more).` : '';
}
function finish() { running = false; window.clearInterval(timer); elapsed.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; prog.hidden = true; runBtn.disabled = false; }

$('dl').onclick = () => download('best.txt', best.value);
$('copy').onclick = () => { void navigator.clipboard.writeText(best.value); };
