/** Shared domain types for crucible-cli. All data originates from BSData; nothing here is invented. */

export interface SourceMeta {
  /** BSData repo path the catalog was built from. */
  repo: string;
  /** Full git commit hash of the BSData clone. */
  commit: string;
  /** Commit date (ISO, as reported by git). */
  commitDate: string;
  /** When catalog.json was generated. */
  generatedAt: string;
  gameSystem: string;
  gameSystemRevision: number | null;
}

/** Base size parsed from the BSData Unit profile "Base" characteristic. */
export interface BaseSize {
  raw: string;
  /** Round base diameter in mm, or null. */
  diameterMm: number | null;
  /** Oval base dims in mm, or null. */
  ovalMm: [number, number] | null;
  /** "Hull" or unparseable: footprint must be estimated from the model, BSData gives no number. */
  estimate: boolean;
  label: 'EXACT' | 'ESTIMATE';
}

export interface ModelProfile {
  name: string;
  M: string; T: number | null; Sv: number | null; W: number | null;
  LD: string; OC: string; InSv: number | null;
  base: BaseSize;
  raw: Record<string, string>;
}

export interface WeaponAbility {
  /** Normalised kind, e.g. 'lethal-hits', 'sustained-hits', 'anti', 'devastating-wounds'. */
  kind: string;
  /** Numeric argument (Sustained X, Melta X, Anti Y+, Rapid Fire X, Blast X ...). */
  n?: number;
  /** Anti-X target keyword(s), slash-separated, lowercase. */
  keyword?: string;
  /** Dice expression argument, e.g. Sustained Hits D3. */
  dice?: string;
  /** Conditional target, e.g. 'non-monster/vehicle' from 'LETHAL HITS: non-MONSTER/VEHICLE'. */
  condition?: string;
  raw: string;
}

export interface WeaponProfile {
  name: string;
  type: 'ranged' | 'melee';
  range: string;
  A: string;
  /** BS for ranged, WS for melee. null for N/A (e.g. Torrent "N/A"). */
  skill: number | null;
  S: string;
  AP: number;
  D: string;
  keywordsRaw: string;
  abilities: WeaponAbility[];
}

export interface RuleText { name: string; text: string; }

export interface PointsTier {
  /** Minimum model count (inclusive) at which this cost applies. */
  minModels: number;
  /** Maximum model count (inclusive) if the tier is a bounded range. */
  maxModels?: number;
  /** Extra condition on the count of another selection (e.g. Hunting Wolves = 0). */
  requires?: { child: string; type: string; value: number };
  pts: number;
  /** How the threshold was derived from BSData modifier conditions. */
  basis: string;
}

export interface UnitEntry {
  id: string;
  name: string;
  catalogue: string;
  entryType: 'unit' | 'model';
  /** Points for the minimum unit size (root cost). */
  pts: number | null;
  pointsTiers: PointsTier[];
  /** BSData 'increment' surcharge for repeated copies of a datasheet in one army (copy number >= fromCopy pays +add). */
  duplicateSurcharge: { fromCopy: number; add: number } | null;
  /** Conditional point modifiers that are not size tiers (kept raw, not applied). */
  otherPointModifiers: string[];
  minModels: number;
  maxModels: number;
  /** Set when BSData constraints could not be reduced to a clean model-count range. */
  sizeNote: string | null;
  /** Model-scoped wargear costs from BSData (model = nearest model ancestor name, '' if none). Zero-cost entries kept so model scoping works. */
  wargearPts: { model: string; item: string; pts: number }[];
  /** Per-model pts for units whose root entry has no pts (cost lives on model entries). */
  modelPts: Record<string, number>;
  profiles: ModelProfile[];
  /** BSData default (minimum-size, mandatory/default wargear) composition. Derived from constraints + defaultSelectionEntryId. */
  defaultLoadout: { model: string; count: number; wargear: string[] }[];
  /** Names of BSData model entries in this unit (may differ from profile names). */
  modelNames: string[];
  weapons: WeaponProfile[];
  keywords: string[];
  factionKeywords: string[];
  abilities: RuleText[];
  rules: RuleText[];
  /** Units this one may join as Leader / Support (from BSData associations). */
  leads: string[];
  supports: string[];
  maxPerForce: number | null;
}

export interface Enhancement {
  id: string;
  name: string;
  catalogue: string;
  detachment: string;
  pts: number;
  text: string;
  /** BSData roster-scope max (usually 1); null if unconstrained. */
  maxPerRoster: number | null;
  /** Raw restriction names from hide conditions, e.g. ['Chaplain','Judiciar']. */
  restrictedTo: string[];
}

export interface Detachment {
  id: string;
  name: string;
  /** Catalogue file that defines the Detachment entry (e.g. Space Marines for Black Templars detachments). */
  catalogue: string;
  /** Force Dispositions granted (BSData categoryLinks matching the five dispositions). */
  dispositions: string[];
  /** Other category links (e.g. '3DP Detachment', 'Doctrines'). */
  categories: string[];
  detachmentPoints: number | null;
  rules: { name: string; text: string }[];
  /** Text after 'Restrictions:' in the detachment rule, verbatim; null if absent; '' if the heading is present but empty. */
  restrictions: string | null;
  /** Hidden unless the roster is an instance of one of these catalogues (resolved to names); [] = visible to every importing army. */
  onlyFor: string[];
  /** BSData error modifiers (e.g. 'not ready'). */
  errors: string[];
}

export interface CatalogueInfo {
  name: string;
  file: string;
  library: boolean;
  revision: number | null;
  /** Catalogues whose root entries this one imports. */
  imports: string[];
}

export interface Catalog {
  source: SourceMeta;
  catalogues: CatalogueInfo[];
  units: UnitEntry[];
  enhancements: Enhancement[];
  detachments: Detachment[];
  stats: Record<string, number>;
}
