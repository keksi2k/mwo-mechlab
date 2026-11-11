// Values that are not in the XML data and only exist in the game client.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function clientExe(gameDir: string): string {
  return join(dirname(gameDir), 'Bin64', 'MWOClient.exe');
}

/**
 * Finds the ghost heat scale in the game client: a float32 array that starts at 0 and then rises strictly in steps
 * that are multiples of 0.01. Tiny denormal values are not accepted, so runs of zeros and other data do not match.
 * Index tables (0, 1, 2, …) are skipped. Returns null if there is not exactly one such array of 10 or more values,
 * so a changed client is noticed.
 */
export function findGhostHeatScale(exe: string): number[] | null {
  if (!existsSync(exe)) return null;
  const buf = readFileSync(exe);
  const round = (x: number) => Math.round(x * 100) / 100;
  const found: number[][] = [];
  for (let o = 0; o + 32 <= buf.length; o += 4) {
    if (buf.readUInt32LE(o) !== 0) continue;
    const values = [0];
    for (let p = o + 4; p + 4 <= buf.length && values.length < 32; p += 4) {
      const x = buf.readFloatLE(p);
      if (!(x > values.at(-1)!) || x < 0.01 || x > 100 || Math.abs(x * 100 - Math.round(x * 100)) > 1e-4) break;
      values.push(round(x));
    }
    if (values.length >= 10 && !values.every(Number.isInteger)) found.push(values);
  }
  return found.length === 1 ? found[0]! : null;
}
