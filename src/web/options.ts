/** Optimizer options used by the web app (same as the local page src/serve.ts, minus file paths). */
import type { OptimizeOptions } from '../optimize/optimizeCore.ts';

export const WEB_BASE: OptimizeOptions = {
  faction: 'Black Templars', detachments: [], points: 2000, minPoints: 1950, top: 3, beamWidth: 80, combosPerBodyguard: 5, mission: 'take-and-hold',
  locks: [], minBandUnits: 2, baselines: [], minTankKillers: 2, minNonBallistusTankKillers: 2, minDedicatedTankKillers: 2, minUnits: 11, baselineWarlords: [], loadoutList: null,
};
