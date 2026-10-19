import { norm } from '../bsdata/parse.ts';
/** Lee's house rules (from the task brief, 2026-10-15). These are user rulings, not BSData. */
export const LEE_RULES = {
  maxLeaderPerUnit: 1,
  maxSupportPerUnit: 1,
  maxEnhancementPerAttachedUnit: 1,
  crusaderInitiateLoadout: { 'Initiate Chainsword': 7, 'Power Fist': 4 } as Record<string, number>,
  /**
   * Sword Brethren pool (Lee's rule 2026-10-15): standalone Sword Brethren models + the Sword Brother in each owned Crusader kit
   * (8 + 2 = 10). Every Crusader Squad fielded uses its kit's Sword Brother, so the Sword Brethren Squad model cap is
   * pool - (Crusader Squad units fielded). Replaces the old flat cap of 8.
   */
  swordBrethrenPoolNote: 'Sword Brethren cap = (standalone SB + Crusader-kit Sword Brothers) - Crusader Squads fielded',
  source: "Lee's rules per task brief 2026-10-15",
} as const;

export const SWORD_BRETHREN = 'Sword Brethren Squad';
export const CRUSADER_SQUAD = 'Crusader Squad';
type OwnedLike = { name: string; quantity: number; totalModels: number; composition: Record<string, unknown> | null };
/** Max Sword Brethren Squad models given the owned collection and how many Crusader Squad units are fielded; null if SB not owned. */
export function swordBrethrenCap(units: OwnedLike[], crusaderUnitsFielded: number): number | null {
  const sb = units.find((u) => u.name === SWORD_BRETHREN); if (!sb) return null;
  const cs = units.find((u) => u.name === CRUSADER_SQUAD);
  const perKit = cs ? Number(cs.composition?.['Sword Brother'] ?? 1) : 0;
  const pool = sb.totalModels + (cs ? cs.quantity * perKit : 0);
  return Math.max(0, pool - crusaderUnitsFielded * (cs ? perKit : 1));
}

/** Lee's ruling 2026-10-19: 4 enhancements at Strike Force, overriding BSData d506fcc (Warhammer 40,000.json constraint 606d-06be-c4b4-f877, max 2). */
export const MAX_ENHANCEMENTS = 4;
export function enhancementLimit(points: number): { max: number; source: string } {
  if (points <= 1000) return { max: 2, source: 'BSData d506fcc constraint 606d-06be-c4b4-f877 (max 2 Enhancements), Incursion' };
  return { max: MAX_ENHANCEMENTS, source: points <= 2000 ? "Lee's ruling 2026-10-19: 4 at Strike Force (overrides BSData's 2)" : "Lee's Strike Force ruling (4) applied to Onslaught (ASSUMPTION)" };
}
/** "(Upgrade)" enhancements: on up to 3 non-CHARACTER units (Lee 2026-10-19; BSData max where it is lower). */
export const UPGRADE_MAX_UNITS = 3;
export const isUpgrade = (name: string) => /\(upgrade\)/i.test(name);
export function enhancementCopies(e: { name: string; maxPerRoster: number | null } | undefined): number {
  if (!e) return 1;
  return isUpgrade(e.name) ? Math.min(e.maxPerRoster ?? UPGRADE_MAX_UNITS, UPGRADE_MAX_UNITS) : (e.maxPerRoster ?? 1);
}
/** Named characters whose BSData d506fcc datasheet lacks the EPIC HERO keyword (data gap): Chaplain Grimaldus is an Epic Hero on his datasheet. */
export const EPIC_HERO_OVERRIDES = ['Chaplain Grimaldus'];
export const isEpicHero = (e: { name: string; keywords: string[] }) => e.keywords.some((k) => /^epic hero$/i.test(k)) || EPIC_HERO_OVERRIDES.some((n) => norm(n) === norm(e.name));
