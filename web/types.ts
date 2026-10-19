/** Messages shared by the page (main.ts) and the worker (worker.ts). */
export interface RunRequest {
  army: string; detachment: string; detachment2: string; disposition: string; input: string;
  minDedicatedTankKillers: number; minBandUnits: number; beamWidth: number;
}
