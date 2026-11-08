// MWO game folder: saved setting, prompt and validation. Never searches on its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = join(import.meta.dirname, '..', '..', '..');
export const SETTINGS_FILE = join(ROOT, 'data', 'settings.json');

interface Settings { gameDir?: string }

function readSettings(): Settings {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Settings; } catch { return {}; }
}

export function savedGameDir(): string | undefined {
  return readSettings().gameDir;
}

export function saveGameDir(gameDir: string): void {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), gameDir }, null, 2) + '\n');
}

/**
 * Turns an input into the "Game" folder (with GameData.pak), or returns undefined.
 * Accepts the Game folder itself, the MWO main folder above it, and quotes
 * (from dragging a folder into the console window).
 */
export function normalizeGameDir(input: string): string | undefined {
  const raw = input.trim().replace(/^["']|["']$/g, '').trim();
  if (!raw) return undefined;
  const dir = resolve(raw);
  for (const candidate of [dir, join(dir, 'Game'), join(dir, 'MechWarrior Online', 'Game')]) {
    if (isGameDir(candidate)) return candidate;
  }
  return undefined;
}

export function isGameDir(dir: string): boolean {
  return basename(dir).toLowerCase() === 'game'
    && existsSync(join(dir, 'GameData.pak'))
    && existsSync(join(dirname(dir), 'build_info.xml'));
}

/** The saved folder, if it still exists. */
export function validSavedGameDir(): string | undefined {
  const saved = savedGameDir();
  return saved && isGameDir(saved) ? saved : undefined;
}

/** Asks for the folder in the console and saves it. undefined on cancel (empty input, end of input). */
export async function askGameDir(): Promise<string | undefined> {
  const saved = savedGameDir();
  const savedValid = saved !== undefined && isGameDir(saved);
  console.log();
  if (saved) console.log(`Currently set: ${saved}${savedValid ? '' : ' (no longer valid)'}`);
  console.log('Enter the path to the "MechWarrior Online" folder (or drag the folder into this window).');
  console.log(savedValid ? 'Press Enter to keep the current folder.' : 'Leave empty to cancel.');

  const rl = createInterface({ input: process.stdin });
  process.stdout.write('> ');
  try {
    for await (const line of rl) {
      const answer = line.trim();
      if (!answer) return savedValid ? saved : undefined;
      const dir = normalizeGameDir(answer);
      if (dir) {
        saveGameDir(dir);
        console.log(`Game folder: ${dir}\n(saved in ${SETTINGS_FILE})`);
        return dir;
      }
      console.log('No MWO installation there (expected a folder with Game\\GameData.pak). Try again, or leave empty to cancel:');
      process.stdout.write('> ');
    }
    return undefined;
  } finally {
    rl.close();
  }
}
