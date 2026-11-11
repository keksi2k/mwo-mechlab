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
- **Confirmed in game:** how quirks are applied (AC/20 on the AS7-D: 3.188 s), hardpoint counting (AS7-D: 2 ballistic), the limit of 91 skill nodes, at most 16 weapons (whether AMS counts is still open).
- **Unverified, please compare with the game:** the calculation with `mechtopspeed`, the effect of map temperature on cooling (not included). Heat capacity and cooling match measurements on the stock AS7-D.
- **Build code:** inferred from example codes from the game (`packages/shared/src/buildcode.ts`, examples in `tests/buildcode.test.ts`). No example of its own yet: stealth, Clan standard armor (inferred from the order in `UpgradeTypes.xml`) and "arm without hand". The omni bit in the code's header is inferred from omnimech examples.
- **Skill tree:** the mechlab only counts nodes; the connected path through the tree is not checked. The categories are inferred from the tree's columns.
- **Not calculated:** ghost heat, Ultra AC double shot, DPS of flamers and rocket launchers.
- **Left out:** `all_*` quirks only count in the search on request and never for AMS, because it is unverified whether they apply there.

## License

The code is under the [MIT License](LICENSE). This covers only the code in this repository, not the game data it reads. Don't publish the contents of `data/`.
