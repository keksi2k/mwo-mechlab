// Sets the game folder that "npm run extract" reads.
//   npm run setup                  asks for the folder
//   npm run setup -- "D:\...\MWO"  sets the folder directly
//   npm run setup -- --if-missing  only asks if no valid folder is saved
import { askGameDir, normalizeGameDir, saveGameDir, SETTINGS_FILE, validSavedGameDir } from './gamedir.ts';

const args = process.argv.slice(2);
const given = args.find((a) => !a.startsWith('--'));

if (given) {
  const dir = normalizeGameDir(given);
  if (!dir) {
    console.error(`No MWO installation there: ${given}`);
    console.error('Expected the "MechWarrior Online" folder or its "Game" subfolder (with GameData.pak).');
    process.exit(1);
  }
  saveGameDir(dir);
  console.log(`Game folder: ${dir}\n(saved in ${SETTINGS_FILE})`);
  process.exit(0);
}

if (args.includes('--if-missing')) {
  const saved = validSavedGameDir();
  if (saved) {
    console.log(`Game folder: ${saved}`);
    process.exit(0);
  }
}

const dir = await askGameDir();
if (!dir) {
  console.log('\nCancelled.');
  process.exit(1);
}
