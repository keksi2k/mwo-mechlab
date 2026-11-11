# MWO Mechlab

Local mechlab with an extended quirk search for MechWarrior Online. All data comes from your own game installation, which is only ever read.

> Unofficial fan project, not affiliated with or endorsed by Piranha Games, Microsoft or Topps. MechWarrior, BattleTech and MechWarrior Online are trademarks of their respective owners. This repository contains no game data or assets; everything is read locally from your own installation.

## Start

On Windows, double-click `start.bat`. It checks Node.js (24 or newer, offers to install it otherwise), installs the dependencies on first start, extracts the game data if there is none yet, starts both servers and opens the browser.

By hand:

```
npm install
npm run setup       # choose the MWO folder (optional, see below)
npm run extract     # reads the game data, repeat after every patch
npm run dev         # then open http://127.0.0.1:5173
```

A running server picks up new data after `npm run extract` by itself; reloading the page in the browser is enough.

### Game folder

`npm run extract` uses the folder saved in `data/settings.json`. If none is saved (or it no longer exists), it asks for one; it never searches on its own.

- `npm run setup` asks for the folder. You can give the "MechWarrior Online" folder or its "Game" subfolder, or drag the folder into the console window.
- `npm run setup -- "D:\path\to\MechWarrior Online"` sets it directly.
- `npm run extract -- --game-dir "…"` still works and also saves the folder.

## Weapons overview

**Weapons** compares one weapon across all mechs that can carry it: ranges, damage, cooldown, heat, DPS and more, including mech quirks, pods and set bonuses, without the skill tree. Omnimechs appear once per chassis, with the best pods for the selected column. "Fits" considers hardpoints and slots, but not weight, and no XL engine for battlemechs. Test mechs with `(T)` in their name are hidden everywhere.

## Max alpha

**Max alpha** ranks every mech by its largest alpha strike that does not overheat, ghost heat included. Per mech it chooses weapons, heat sinks, ammo and, for battlemechs, armor type, structure and engine; omnimechs try pods one component at a time. Simplifications: full armor (torsos 3:1 front to rear), one ton of ammo per ammo type, single heat sinks (they give more heat capacity per ton and slot than doubles), no skills, no jump jets or other equipment, no cooling during the volley. Options: only some weapon types, a minimum optimal range, a minimum speed, and mixing weapons of one ghost heat group (unverified, off by default).

The first calculation for a set of options runs in the background on all CPU cores but one (about a minute on 12 cores, seven on one); the result is stored in `data/build-<nr>/alpha/` until the next patch. To leave more cores free, for example while playing, set `MWO_ALPHA_THREADS`, e.g. `set MWO_ALPHA_THREADS=4` before `npm run dev`. For battlemechs the weapon search is exhaustive unless a row is marked "best found"; the engine is still a heuristic choice (per engine type the lightest one that reaches the minimum speed, plus rating 250). Omnimech results are always "best found", because the pods are chosen heuristically. Machine guns and flamers are left out, because they fire continuously. In the mechlab, **Max clean alpha** runs the same search for the open mech.

## Patch changes

Every `npm run extract` after a patch writes a new `data/build-<nr>/` folder and keeps the old ones. **Patch changes** compares two of them: new and removed mechs, changed quirks of mechs, pods and set bonuses, and changed weapon and item values.

## Mechlab extras

- Heat: alpha heat with ghost heat, the estimated peak on the heat bar, alphas until overheating, cool-down time and time to overheat when firing everything on cooldown.
- Damage over range for the whole build as a chart.
- **Fill heat sinks** adds heat sinks while weight and slots allow.
- Undo and redo (Ctrl+Z, Ctrl+Y). The address bar always holds the current build code (skills as an extra parameter), so a reload or a copied link shows the same build.

## Languages

English and German, switchable at the top right. The first visit follows the browser language. Weapons, items and skills keep their game names in both languages, because only the English game texts are installed. Texts live in `packages/shared/src/i18n.ts` (game logic) and `packages/web/src/i18n.ts` (UI).

## Storage

- `data/build-<nr>/`: extracted game data as JSON and `mwo.sqlite`, can be regenerated at any time
- `data/user.sqlite`: saved builds, survives patches
- `data/settings.json`: the chosen game folder

## Checks

```
npm test            # data, rules and search against the real game data
npm run e2e         # browser test with local Chrome; starts its own servers and uses a temporary database
npm run typecheck
```

`npm test` and `npm run e2e` need extracted game data, so run `npm run extract` with your own installation first.

## What is estimated

Everything that is not directly in the game data is collected in `ASSUMPTIONS` in `packages/shared/src/rules.ts`.

- **Checked against all stock mechs:** slots, hardpoints, armor limit, engine limits. For weight there are five exceptions that are over the limit according to the game data itself (see `tests/rules.test.ts`).
- **Confirmed in game:** how quirks are applied (AC/20 on the AS7-D: 3.188 s), hardpoint counting (AS7-D: 2 ballistic), the limit of 91 skill nodes, at most 16 weapons including AMS, ghost heat of one weapon type (3 Snub-Nose PPC on the AS7-D: 56 %), the clean alpha of 188.5 on the BSK-3.
- **Unverified, please compare with the game:** the calculation with `mechtopspeed`, the effect of map temperature on cooling (not included). Heat capacity and cooling match measurements on the stock AS7-D.
- **Build code:** inferred from example codes from the game (`packages/shared/src/buildcode.ts`, examples in `tests/buildcode.test.ts`). No example of its own yet: stealth, Clan standard armor (inferred from the order in `UpgradeTypes.xml`) and "arm without hand". The omni bit in the code's header is inferred from omnimech examples.
- **Skill tree:** the mechlab only counts nodes; the connected path through the tree is not checked, because the game data only has each node's column and row, not its links. The categories are inferred from the tree's columns.
- **Ghost heat:** the scale per weapon count (0, 0.08, 0.18, 0.3, 0.45, 0.6, 0.8, 1.1, 1.5, 2, 3, 5) is not in the XML data; it was read from `MWOClient.exe` and is kept as a constant in `ASSUMPTIONS`. Unverified: several weapon types in one group, more than 12 weapons, weapons with a penalty but no group ID.
- **Estimated:** the heat bar peak after an alpha (beams spread their heat over their duration; stock AS7-D 33 % calculated, 32 % measured), Ultra AC DPS with double shot (expected value from jam chance and jam time, shown separately), damage between the range breakpoints (linear).
- **Not calculated:** DPS of flamers and rocket launchers; the data has no rate for flamer damage, and rocket launchers fire once.
- **Left out:** `all_*` quirks only count in the search on request and never for AMS, because it is unverified whether they apply there.

## License

The code is under the [MIT License](LICENSE). This covers only the code in this repository, not the game data it reads. Don't publish the contents of `data/`.
