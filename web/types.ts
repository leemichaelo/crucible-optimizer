/** Messages shared by the page (main.ts) and the worker (worker.ts). */
export interface RunRequest {
  army: string; detachment: string; detachment2: string; detachment3: string; disposition: string; input: string;
  minDedicatedTankKillers: number; minBandUnits: number; beamWidth: number; bandThreshold: number;
  /** Game size (1000 / 2000 / 3000); lists may come in up to 50 points under. */
  points: number;
  /** Warlord (auto-filled from a pasted list or typed): locked into every list and made WARLORD. Empty = heuristic pick. */
  warlord: string;
}
