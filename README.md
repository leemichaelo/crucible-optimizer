# Crucible list optimizer (static web build)

**Site:** https://leemichaelo.github.io/crucible-optimizer/

A Warhammer 40,000 (11th edition data) army-list optimizer that runs **entirely in the browser**: no server, no account.
Pick an army, a detachment (optionally a second one), a Force Disposition, optionally paste a list (40k App text) or a
collection JSON, and press **Run**. The optimizer runs in a Web Worker (the page stays responsive), shows progress and
elapsed time, and produces a `best.txt` in 40k App text format.

With the paste box empty it uses Lee's collection (owned-model caps, 2026-10-15) and Lee's list export (unit wargear).

## Rules applied

- Owned models only; no unattached characters; max 1 Leader + 1 Support per unit.
- Enhancements: 4 at Strike Force (overrides BSData's 2). "(Upgrade)" enhancements go on non-Character units, up to 3 units
  each; every copy uses one of the 4 slots and is paid each time. Max 1 enhancement per unit including attached units.
  None on Epic Heroes (BSData keyword; Chaplain Grimaldus is treated as an Epic Hero, his BSData datasheet lacks the keyword).
  Furious Assault does not stack with Terminatus Assault's Sustained Hits (Sustained Hits never stacks).
- HARD default: at least 2 **dedicated tank killers** besides the Ballistus: not characters, not melee infantry bricks
  (infantry must pass on ranged weapons alone; e.g. Repulsor Executioner, Brutalis Dreadnought, Eradicators, Land Raiders),
  each passing the >= 45% wounds test vs T10-12 vehicles. Can be unticked or changed on the page. If the collection cannot
  satisfy it, the page says so and lists the qualifying owned units.
- HARD: at least 2 units able to remove 80+ points of a target in every toughness band (list-building checklist), >= 11 units.

## Data and caveats

- Unit data, points and rules: BSData wh40k-11e pinned at commit `d506fcc` (2026-10-14). Points are **not official** and may
  lag MFM / points updates; BSData rules text is thinner than the datasheets.
- Stratagems: Wahapedia (a **secondary** source; BSData has none at this commit).
- **All scores are ESTIMATE / HEURISTIC.** They rank lists; they do not predict games.
- Opponent field: 14 lists from a 2026-10 RTT, anonymised (`web/data-src/opponents`).

## Layout

- `src/` the optimizer core (pure TypeScript, no file access): catalog lookup, selection, beam search, validator, export.
- `web/` the page (`index.html`, `main.ts`), the Web Worker (`worker.ts`) and the input data (`data-src/`).
- `scripts/build-web-data.ts` splits `data/catalog.json` into per-catalogue JSON shards (`web/public/data/units/*.json`) plus
  a small `refs.json` for the opponent lists; an army loads only its own shards and their library imports.
- `scripts/check-shard-equivalence.ts` checks the optimizer gives byte-identical results on shards vs the full catalog.

```sh
npm ci
npm run typecheck
npm run build      # -> web/dist (deployed by .github/workflows/pages.yml)
npm run dev        # local dev server
```

Not affiliated with Games Workshop. Warhammer 40,000 is a trademark of Games Workshop Ltd.
