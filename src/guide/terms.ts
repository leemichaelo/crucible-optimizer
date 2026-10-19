/**
 * Every concrete rule/number in /workspace/codex-rebuild/list-guide.pdf (1 page; `pdftotext -layout` output is
 * word-for-word identical to list-guide.txt, verified 2026-10-15). Sections are the PDF's own headings.
 * Quotes are verbatim. `computable` terms are encoded in src/assess (and the optimizer where noted).
 */
export const GUIDE_FILE = '/workspace/codex-rebuild/list-guide.pdf';
export interface GuideTerm { id: string; section: string; quote: string; computable: boolean; encodedAs?: string; whyNot?: string }
export const GUIDE_TERMS: GuideTerm[] = [
  { id: 'tiers-def', section: 'Header (tier boxes)', quote: '3 Heavies 200+ pts · 4 Workhorses 115–195 pts · 6 Utility under 115 pts', computable: true, encodedAs: 'tiersOf(): attached unit counted once at combined points; assess.bands.tiers' },
  { id: 'typical-shape', section: 'Header', quote: 'The typical winning list: 3 · 4 · 6, about 13 units on the table', computable: true, encodedAs: 'assess force-size band (13 = typical); optimizer unitCount term' },
  { id: 'all-three-tiers', section: 'Header', quote: '43 of 49 run all three tiers', computable: true, encodedAs: 'assess.guide.allThreeTiers (>=1 unit in each tier)' },
  { id: 'heavy-share', section: 'Header', quote: 'The Heavies hold about 45% of the points', computable: true, encodedAs: 'assess.guide.heavyShare (share of points in 200+ pt units; reported vs 45%, no pass/fail band because the guide says "about")' },
  { id: 'disposition-medians', section: '01 PICK YOUR DISPOSITION', quote: 'PRIORITY ASSETS 3·4·7 (14) · TAKE AND HOLD 3·4·4 (12) · DISRUPTION 3·5·7 (14) · PURGE THE FOE 4·2·5 (12) · RECONNAISSANCE 1·5·11 (18)', computable: true, encodedAs: 'assess.guide.dispositionShape (distance from the median for the list\'s disposition); optimizer TIER_TARGETS' },
  { id: 'start-shape', section: '02 BUILD THE THREE TIERS', quote: 'Start from about 3 Heavies, 4 Workhorses and 6 Utility, then bend it for your disposition. Recon spreads out the most.', computable: true, encodedAs: 'same as tiers-def / disposition-medians' },
  { id: 'cover-twice', section: '02 BUILD THE THREE TIERS', quote: 'Cover a job twice: 48 of the 49 lists took at least one unit more than once.', computable: true, encodedAs: 'assess.guide.duplicatedDatasheets (datasheets appearing 2+ times)' },
  { id: 'damage-check', section: '04 RUN THE DAMAGE CHECK', quote: 'At least two units for every toughness band: units that can remove 80+ points of a target in that band in one activation.', computable: true, encodedAs: 'BAND_REFS + exact engine; assess toughness-spread band; optimizer HARD band rule' },
  { id: 'band-list', section: '04 RUN THE DAMAGE CHECK', quote: 'T3–4 Guardsmen, Genestealers · T5 Intercessors, Ork Boyz · T6 Terminators, Heavy Intercessors · T7–9 Rhino, Dreadknight · T10–11 Leman Russ · T12+ Land Raider, Repulsor', computable: true, encodedAs: 'one BSData reference per band (first-named example where it exists in BSData: Cadian Shock Troops x10, Intercessor Squad x5, Terminator Squad x5, Rhino, Leman Russ Battle Tank, Land Raider). Second examples not used.' },
  { id: 'horde-volume', section: '04 RUN THE DAMAGE CHECK', quote: 'Plus enough volume (lots of attacks) for horde armies.', computable: false, whyNot: 'no number given for "enough". assess reports an anti-horde band, but its threshold is HEURISTIC (see bands.antiHorde).' },
  { id: 'damage-check-rate', section: '04 RUN THE DAMAGE CHECK', quote: '42 of the 49 winning lists pass.', computable: false, whyNot: 'prevalence statistic about the source sample, not a property of a list.' },
  { id: 'buy-toward-gap', section: '05 BUY TOWARD THE GAP', quote: "Your next purchase comes from the tier or band you're short in, not another copy of what you already have plenty of.", computable: true, encodedAs: 'assess.guide.gaps (tiers below the disposition median and bands with <2 units); advisory only' },
  { id: 'test-first', section: '06 TEST IT FIRST', quote: 'Play it on Tabletop Simulator before you spend the money.', computable: false, whyNot: 'advice about play, not a list property.' },
  { id: 'iterate', section: '07 ITERATE', quote: "Play your games, see what's working, adjust the list, and run it through again.", computable: false, whyNot: 'advice about play, not a list property.' },
  { id: 'sample', section: 'Footer', quote: 'SOURCE: 49 X-0 / X-1 GT LISTS, 2026', computable: false, whyNot: 'provenance of the medians; recorded with every guide term instead.' },
  { id: 'skeleton', section: 'Footer box', quote: "A skeleton, not a rule. Your list doesn't have to hit these numbers to be good, and some of the lists that won didn't.", computable: false, whyNot: 'caveat; reflected by assess reporting guide terms as observations, never as errors.' },
];
