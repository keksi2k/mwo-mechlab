import { join, resolve } from 'node:path';
import { extract } from './extract.ts';
import { writeOutput } from './export.ts';
import { askGameDir, normalizeGameDir, saveGameDir, validSavedGameDir } from './gamedir.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// --game-dir is used and saved; otherwise the saved folder; otherwise ask.
const givenDir = arg('game-dir');
let gameDir: string | undefined;
if (givenDir) {
  gameDir = normalizeGameDir(givenDir);
  if (!gameDir) {
    console.error(`No MWO installation there: ${givenDir}`);
    process.exit(1);
  }
  saveGameDir(gameDir);
} else {
  gameDir = validSavedGameDir() ?? (process.stdin.isTTY ? await askGameDir() : undefined);
  if (!gameDir) {
    console.error('No valid MWO game folder set. Set one with "npm run setup".');
    process.exit(1);
  }
}
console.log(`Game folder: ${gameDir}`);
const out = resolve(arg('out') ?? 'data');

const started = Date.now();
const data = await extract(gameDir, (m) => console.log(m));
const dir = join(out, `build-${data.meta.buildNumber}`);
writeOutput(data, dir);

console.log(`\nBuild ${data.meta.buildVersion} (${data.meta.buildPlan}) → ${dir}`);
console.log(Object.entries(data.meta.counts).map(([k, v]) => `${k}: ${v}`).join(', '));
console.log(`Warnings: ${data.meta.warnings.length}`);
for (const w of data.meta.warnings.slice(0, 40)) console.log(`  - ${w}`);
if (data.meta.warnings.length > 40) console.log('  … more in meta.json');
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
