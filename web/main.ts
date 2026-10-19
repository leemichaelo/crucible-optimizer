/** Page script: form <-> worker. All computation happens in worker.ts (a Web Worker), so the page never freezes. */
import { DISPOSITIONS } from '../src/select/selectionCore.ts';
import type { RunRequest } from './types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const army = $<HTMLSelectElement>('army'), det = $<HTMLSelectElement>('detachment'), det2 = $<HTMLSelectElement>('detachment2'), disp = $<HTMLSelectElement>('disposition');
const runBtn = $<HTMLButtonElement>('run'), status = $('status'), prog = $('progress'), bar = $<HTMLProgressElement>('bar'), phase = $('phase'), elapsed = $('elapsed');
const out = $('out'), best = $<HTMLTextAreaElement>('best'), summary = $('summary'), took = $('took'), gaps = $('gaps');
let dets: { name: string; dispositions: string[]; dp: number | null }[] = [];
let running = false; let t0 = 0; let timer = 0;

for (const d of DISPOSITIONS) disp.add(new Option(d, d));
disp.value = 'Purge the Foe';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.postMessage({ type: 'init', dataUrl: new URL('data/', document.baseURI).href });

function fillDetachments() {
  const keep1 = det.value, keep2 = det2.value;
  det.replaceChildren(new Option('all (rank each that grants the disposition; slow)', 'all'));
  det2.replaceChildren(new Option('(none)', ''));
  for (const d of dets) { const label = `${d.name} [${d.dispositions.join(', ') || 'no disposition in BSData'}]`; det.add(new Option(label, d.name)); det2.add(new Option(label, d.name)); }
  det.value = dets.some((d) => d.name === keep1) ? keep1 : (dets.find((d) => /vow-sworn/i.test(d.name))?.name ?? dets[0]?.name ?? 'all');
  det2.value = dets.some((d) => d.name === keep2) ? keep2 : '';
  hint();
}
function hint() {
  const chosen = [det.value, det2.value].filter((x) => x && x !== 'all');
  const grants = new Set(chosen.flatMap((n) => dets.find((d) => d.name === n)?.dispositions ?? []));
  $('dethint').textContent = det.value === 'all' ? 'Each detachment that grants the disposition is optimized and ranked (several minutes each).'
    : `${chosen.join(' + ')} grants: ${[...grants].join(', ') || 'none'}${grants.has(disp.value) ? '' : ` (not ${disp.value}: the run will be refused)`}. A pair: disposition valid if granted by either; Detachment Points checked.`;
}
det.onchange = det2.onchange = disp.onchange = hint;
army.onchange = () => { runBtn.disabled = true; det.disabled = det2.disabled = true; status.textContent = `Loading ${army.value}…`; worker.postMessage({ type: 'loadArmy', army: army.value }); };
$<HTMLInputElement>('dedOn').onchange = () => { $<HTMLInputElement>('ded').disabled = !$<HTMLInputElement>('dedOn').checked; };

$('f').onsubmit = (e) => {
  e.preventDefault(); if (running) return;
  const req: RunRequest = { army: army.value, detachment: det.value, detachment2: det.value === 'all' ? '' : det2.value, disposition: disp.value, input: $<HTMLTextAreaElement>('input').value,
    minDedicatedTankKillers: $<HTMLInputElement>('dedOn').checked ? Math.max(1, Number($<HTMLInputElement>('ded').value) || 2) : 0,
    minBandUnits: Math.max(0, Number($<HTMLInputElement>('band').value) || 0), beamWidth: Math.max(5, Number($<HTMLInputElement>('beam').value) || 40) };
  running = true; runBtn.disabled = true; prog.hidden = false; bar.removeAttribute('value'); phase.textContent = 'starting'; status.textContent = 'Running in a Web Worker…';
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
    dets = m.detachments; fillDetachments(); det.disabled = det2.disabled = false; runBtn.disabled = running;
    status.textContent = `${m.army}: ${m.units} BSData units loaded in ${(m.loadMs / 1000).toFixed(1)} s. Ready.`;
  } else if (m.type === 'progress') {
    const p = m.p;
    const frac = p.phase === 'cells' ? 0.05 + 0.75 * (p.done / Math.max(1, p.total)) : p.phase === 'search' ? 0.8 + 0.15 * Math.min(1, p.done / Math.max(1, p.total)) : p.phase === 'validate' ? 0.96 : p.phase === 'done' ? 1 : 0.02;
    bar.max = 100; bar.value = Math.round(100 * ((p.run - 1) + frac) / p.runs);
    phase.textContent = `${p.runs > 1 ? `[${p.run}/${p.runs}] ` : ''}${p.detachments.join(' + ')}: ${p.message}`;
  } else if (m.type === 'result') {
    finish();
    out.hidden = false; best.value = m.bestTxt; took.textContent = `(${(m.elapsedMs / 1000).toFixed(1)} s in this browser${m.summary.cache.entriesBefore ? `, ${m.summary.cache.entriesBefore} cached cells reused` : ''})`;
    const s = m.summary;
    summary.innerHTML = m.feasible
      ? `<p class="ok">Best list: ${esc(s.detachments.join(' + '))} · ${esc(s.disposition)} · ${s.points} pts · score ${s.score} (HEURISTIC)</p>
         <p>Dedicated tank killers: ${esc(s.dedicatedTankKillers.join('; ') || 'none')}<br>Enhancements: ${esc(s.enhancements.join('; ') || 'none')}${s.ranking.length > 1 ? `<br>Ranking: ${esc(s.ranking.map((r: { detachments: string; bestScore: number | null }) => `${r.detachments} ${r.bestScore ?? 'n/a'}`).join(' · '))}` : ''}${s.inputNote.length ? `<br>${esc(s.inputNote.join('; '))}` : ''}</p>`
      : `<p class="bad">No list meets every hard rule.\n${esc(s.infeasible)}</p>`;
    gaps.textContent = [...s.gaps, ...(s.skipped.length ? [`Skipped (do not grant ${s.disposition}): ${s.skipped.join(', ')}`] : [])].join('\n');
    status.textContent = 'Done.';
    out.scrollIntoView({ behavior: 'smooth' });
  } else if (m.type === 'error') {
    finish(); status.textContent = ''; out.hidden = false; summary.innerHTML = `<p class="bad">${esc(m.message)}</p>`; best.value = ''; took.textContent = '';
  }
};
function finish() { running = false; window.clearInterval(timer); elapsed.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; prog.hidden = true; runBtn.disabled = false; }

$('dl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([best.value], { type: 'text/plain' })); a.download = 'best.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
$('copy').onclick = () => { void navigator.clipboard.writeText(best.value); };
