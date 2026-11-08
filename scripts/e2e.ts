// End-to-end test in a real browser. Requires Chrome.
// Starts its own servers on separate ports with a temporary database; a running `npm run dev` and
// saved builds are not touched.
// Usage: npm run e2e   (screenshots go to --shots, default: a temp directory)
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 4690;
const WEB_PORT = 5183;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
].find(existsSync);
if (!CHROME) throw new Error('Chrome not found');

const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg >= 0 ? process.argv[shotsArg + 1]! : mkdtempSync(join(tmpdir(), 'mwo-e2e-shots-'));
mkdirSync(shots, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'mwo-e2e-profile-'));
const sandbox = mkdtempSync(join(tmpdir(), 'mwo-e2e-data-'));

const env = {
  ...process.env, PORT: String(API_PORT), MWO_API_PORT: String(API_PORT),
  MWO_USER_DB: join(sandbox, 'user.sqlite'), MWO_VITE_CACHE: join(sandbox, 'vite-cache'),
};
const servers: ChildProcess[] = [
  spawn(process.execPath, ['packages/server/src/main.ts'], { stdio: 'ignore', env }),
  spawn(`npx vite --port ${WEB_PORT} --strictPort`, { stdio: 'ignore', env, shell: true, cwd: 'packages/web' }),
];
function stopProcess(p: ChildProcess) {
  // On Windows, kill() only ends the shell, not the process behind it.
  if (process.platform === 'win32' && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else p.kill();
}
async function waitForServer(url: string) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server not responding: ${url}`);
}
await waitForServer(`http://127.0.0.1:${API_PORT}/api/builds`);
await waitForServer(`${BASE}/`);
const PORT = 9333;
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1500,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        return ws;
      }
    } catch { /* Chrome still starting */ }
    await sleep(200);
  }
  throw new Error('Chrome not responding');
}

const ws = await connect();
let nextId = 1;
const pending = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>();
const consoleErrors: string[] = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data)) as { id?: number; method?: string; params?: { exceptionDetails?: { text: string; exception?: { description?: string } }; type?: string; args?: { value?: unknown }[] } };
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m as never);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'error');
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    consoleErrors.push(String(m.params.args?.[0]?.value));
  }
};
function send<T>(method: string, params: object = {}): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (v) => (v.error ? reject(new Error(v.error.message)) : resolve(v.result as T)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function js<T>(expression: string): Promise<T> {
  const r = await send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expression: string, what: string, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await js<boolean>(`!!(${expression})`)) return;
    await sleep(80);
  }
  await shot('timeout');
  throw new Error(`Timeout: ${what}`);
}
async function shot(name: string) {
  const r = await send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(r.data, 'base64'));
}
/** Sets the value so that React notices the change. */
const setValue = (selector: string, value: string) => js(`(() => {
  const el = ${selector};
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
})()`);
const clickText = (selector: string, text: string) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})).click()`);
const issues = () => js<string>(`document.querySelector('.banner.error')?.innerText ?? ''`);
const stat = (label: string) => js<string>(`[...document.querySelectorAll('.stat')].find((s) => s.querySelector('.stat-label').textContent === ${JSON.stringify(label)}).querySelector('.stat-value').textContent`);
const step = (m: string) => console.log(`✔ ${m}`);

let failed = false;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  // The main test runs in English; switching to German is checked at the end.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `if (!localStorage.getItem('mwo.locale')) localStorage.setItem('mwo.locale', 'en');` });
  await send('Page.navigate', { url: `${BASE}/#/search` });

  // Search: AMS preset
  await waitFor(`document.querySelector('.presets button')`, 'presets');
  await clickText('.presets button', 'Best AMS setup');
  await waitFor(`document.querySelectorAll('.results-table .row').length > 50`, 'AMS results');
  const rows = await js<{ name: string; hp: string; values: string[] }[]>(`[...document.querySelectorAll('.results-table .row')].map((r) => ({
    name: r.querySelector('.mech-name').textContent,
    hp: r.querySelector('.hp-ams').textContent,
    values: [...r.querySelectorAll('td.num')].map((t) => t.textContent),
  }))`);
  const ams = rows.map((r) => parseInt(r.hp));
  assert.ok(ams.every((v, i) => i === 0 || ams[i - 1]! >= v), 'sorted by AMS hardpoints');
  step(`AMS search: ${rows.length} rows, top ${rows[0]!.name} with ${rows[0]!.hp}`);
  await shot('1-search-ams');

  // Filter by weight class
  await clickText('.chips button', 'Heavy');
  await waitFor(`[...document.querySelectorAll('.results-table .row td:nth-child(2)')].every((t) => Number(t.textContent) >= 60 && Number(t.textContent) <= 75)`, 'heavy filter');
  step('Heavy filter works');
  await clickText('.chips button', 'Heavy');

  // Text filter finds WLF-1B with the quirk source
  await setValue(`document.querySelector('.filters .field input')`, 'WLF-1B');
  await waitFor(`[...document.querySelectorAll('.results-table .row')].some((r) => r.textContent.includes('+1.5'))`, 'WLF-1B quirk');
  await js(`[...document.querySelectorAll('.results-table .row')].find((r) => r.textContent.includes('+1.5')).click()`);
  await waitFor(`document.querySelector('.detail')?.textContent.includes('antimissilesystem_damage_additive')`, 'quirk source');
  step('WLF-1B: AMS damage +1.5 shown with its source');
  await shot('2-search-detail');

  // Omnimech: open Kit Fox with its pod selection in the mechlab
  await setValue(`document.querySelector('.filters .field input')`, 'Kit Fox');
  await waitFor(`[...document.querySelectorAll('.results-table .row')].length === 1 && document.querySelector('.results-table .row').textContent.includes('KIT FOX')`, 'Kit Fox');
  await js(`document.querySelector('.results-table .row button.primary').click()`);
  await waitFor(`document.querySelector('.comp-grid')`, 'Mechlab');
  assert.ok((await js<string>('location.hash')).includes('pods='), 'pods in the URL');
  await waitFor(`[...document.querySelectorAll('.quirks h4')].length > 0`, 'Quirks');
  await shot('3-mechlab-kitfox');
  step(`Mechlab opens an omnimech from the search: ${await js<string>('location.hash')}`);

  // Stock Atlas: valid, values are correct
  await send('Page.navigate', { url: `${BASE}/#/mechlab/as7-d` });
  await waitFor(`document.querySelector('.lab-head h2')?.textContent === 'ATLAS AS7-D'`, 'AS7-D');
  assert.equal(await issues(), '', 'stock is valid');
  assert.equal(await stat('Weight'), '100.00 / 100 t');
  assert.equal(await stat('Speed'), '48.6 km/h');
  await shot('4-mechlab-as7d');
  step('AS7-D stock: valid, 100 t, 48.6 km/h');

  // Make it invalid: wrong hardpoint
  await clickText('.comp', 'RA');
  await js(`[...document.querySelectorAll('.comp')].find((c) => c.querySelector('.comp-title strong').textContent === 'RA').click()`);
  await setValue(`document.querySelector('.picker .tabs input')`, 'AC/20');
  await waitFor(`[...document.querySelectorAll('.pick')].some((p) => p.textContent.startsWith('AC/20'))`, 'AC/20 in the picker');
  await js(`[...document.querySelectorAll('.pick')].find((p) => p.textContent.startsWith('AC/20')).click()`);
  await waitFor(`document.querySelector('.banner.error')`, 'error message');
  const msg = await issues();
  assert.match(msg, /ballistic/, 'wrong hardpoint');
  assert.match(msg, /the limit is 100 t/, 'overweight');
  await shot('5-mechlab-error');
  step('Invalid build is reported');

  // Remove it, install AMS: the AS7-D has AMS in the left arm
  await js(`[...document.querySelectorAll('.comp')].find((c) => c.querySelector('.comp-title strong').textContent === 'RA').querySelector('.slot.kind-weapon:last-of-type').click()`);
  await waitFor(`![...document.querySelectorAll('.comp .slot')].some((s) => s.textContent.startsWith('AC/20') && s.closest('.comp').querySelector('.comp-title strong').textContent === 'RA')`, 'AC/20 removed');
  assert.equal(await issues(), '', 'valid again');
  await js(`[...document.querySelectorAll('.comp')].find((c) => c.querySelector('.comp-title strong').textContent === 'LA').click()`);
  await setValue(`document.querySelector('.picker .tabs input')`, 'AMS');
  await waitFor(`[...document.querySelectorAll('.pick')].some((p) => p.querySelector('.pick-name').textContent === 'AMS')`, 'AMS in the picker');
  await js(`[...document.querySelectorAll('.pick')].find((p) => p.querySelector('.pick-name').textContent === 'AMS').click()`);
  await waitFor(`[...document.querySelectorAll('.weapons td')].some((t) => t.textContent.endsWith('AMS'))`, 'AMS installed');
  step('AMS installed');

  // Save and reload
  const name = `E2E test ${Date.now()}`;
  await setValue(`document.querySelector('.lab-actions input')`, name);
  await clickText('.lab-actions button', 'Save build');
  await waitFor(`document.querySelector('.lab-actions')?.textContent.includes('Saved as a new build')`, 'saving');
  await send('Page.navigate', { url: `${BASE}/#/builds` });
  await waitFor(`[...document.querySelectorAll('.builds td')].some((t) => t.textContent === ${JSON.stringify(name)})`, 'build in the list');
  await js(`[...document.querySelectorAll('.builds tr')].find((r) => r.textContent.includes(${JSON.stringify(name)})).querySelector('button.primary').click()`);
  await waitFor(`location.hash.includes('build=') && [...document.querySelectorAll('.weapons td')].some((t) => t.textContent.endsWith('AMS'))`, 'build loaded');
  step('Build saved and reloaded');

  // Comparison
  await send('Page.navigate', { url: `${BASE}/#/builds` });
  await waitFor(`document.querySelector('.builds input[type=checkbox]')`, 'build list');
  await js(`[...document.querySelectorAll('.builds tr')].find((r) => r.textContent.includes(${JSON.stringify(name)})).querySelector('input').click()`);
  await waitFor(`[...document.querySelectorAll('.builds h2')].some((h) => h.textContent === 'Compare')`, 'comparison');
  await shot('6-builds');
  step('Comparison visible');

  // Build code: import from the game and identical export
  const KFX_C = 'A84D<0J0pB0>J7|0S|0S|0S|0SqB0<J7|URrB0;J7|mB|nB|iB|iBsB0`G7|EC|EC|EC|DC|l<2|m<2tF0?J7uF0@J7vB0:J7w:0:0:0';
  await send('Page.navigate', { url: `${BASE}/#/mechlab` });
  await waitFor(`document.querySelector('.picker-page .code-import input')`, 'code field');
  await setValue(`document.querySelector('.picker-page .code-import input')`, 'Garbage');
  await clickText('.picker-page button', 'Import');
  await waitFor(`document.querySelector('.picker-page .bad')`, 'error for an invalid code');
  await setValue(`document.querySelector('.picker-page .code-import input')`, KFX_C);
  await clickText('.picker-page button', 'Import');
  await waitFor(`document.querySelector('.lab-head h2')?.textContent === 'KIT FOX KFX-C'`, 'imported mech');
  await waitFor(`document.querySelector('.build-code input[readonly]')`, 'export field');
  assert.equal(await js<string>(`document.querySelector('.build-code input[readonly]').value`), KFX_C, 'export matches the code from the game');
  assert.equal(await issues(), '', 'imported build is valid');
  step('Build code: import and identical export');

  // Build code: battlemech with upgrades, Artemis swaps the ammo
  const AS7D = 'A@000:N1|jb|h^|h^|Y?|Y?p01|X?|@O|@Oq01|Z?|7@|[O|[O|\\O|h^r41|h^|Y?s41|h^|Y?tB1|h^|h^uB1|h^|h^vB0|h^wL0D0D0';
  await send('Page.navigate', { url: `${BASE}/#/mechlab/as7-d` });
  await waitFor(`document.querySelector('.build-code input[readonly]')?.value === ${JSON.stringify(AS7D)}`, 'AS7-D export');
  await js(`[...document.querySelectorAll('.loadout .check input')][0].click()`);
  await waitFor(`document.querySelector('.build-code input[readonly]').value.startsWith('A@001:') && document.querySelector('.build-code input[readonly]').value.includes('|^O|^O|_O')`, 'Artemis in the export');
  await js(`[...document.querySelectorAll('.loadout .check input')][0].click()`);
  await waitFor(`document.querySelector('.build-code input[readonly]').value === ${JSON.stringify(AS7D)}`, 'export back to stock after removing Artemis');
  step('Build code: AS7-D exports like the game, Artemis swaps the ammo and back');

  // Skill tree: categories, limit 91, locked nodes
  await send('Page.navigate', { url: `${BASE}/#/mechlab/as7-d` });
  await waitFor(`document.querySelector('.skills button.link')`, 'Skill Tree');
  await js(`document.querySelector('.skills button.link').click()`);
  await waitFor(`document.querySelectorAll('.skill-category').length === 7`, 'seven categories');
  assert.ok(await js<boolean>(`[...document.querySelectorAll('.skill-row')].find((r) => r.textContent.includes('Lift Speed')).querySelector('input').disabled`), 'Lift Speed locked without jump jets');
  await js(`(async () => {
    for (const r of document.querySelectorAll('.skill-row input:not(:disabled)')) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, r.max);
      r.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((res) => setTimeout(res, 15));
    }
  })()`);
  await waitFor(`document.querySelector('.skills h3').textContent.includes('91 / 91')`, 'limit 91');
  assert.equal(await issues(), '', 'limit is not exceeded');
  await js(`document.querySelector('.build-code').scrollIntoView()`);
  await shot('8-skilltree');
  step('Skill tree: 7 categories, limit 91, locks');

  // Weapon limit hint in the search
  await send('Page.navigate', { url: `${BASE}/#/search` });
  await waitFor(`document.querySelector('.filters .field input')`, 'search');
  await setValue(`document.querySelector('.filters .field input')`, 'CRD-CR');
  await waitFor(`[...document.querySelectorAll('.results-table .row')].length === 1 && document.querySelector('.limit-hint')?.textContent.includes('16')`, 'hint at 17 hardpoints');
  step('Search: hint at more than 16 hardpoints');
  await setValue(`document.querySelector('.filters .field input')`, '');

  // Weapons overview: ER Large Laser, best mech on top, source and pods visible
  await send('Page.navigate', { url: `${BASE}/#/weapons` });
  await waitFor(`document.querySelectorAll('.weapons-table .row').length > 100`, 'weapons overview');
  const maxRanges = await js<number[]>(`[...document.querySelectorAll('.weapons-table .row')].map((r) => Number(r.querySelector('td.sorted').textContent.replace(/\\D/g, '')))`);
  assert.ok(maxRanges[0]! > 1500, `best range ${maxRanges[0]}`);
  assert.ok(maxRanges.every((v, i) => i === 0 || maxRanges[i - 1]! >= v), 'sorted descending');
  assert.equal(await js<number>(`document.querySelectorAll('.weapons-table .base-row').length`), 2);
  await js(`document.querySelector('.weapons-table .row').click()`);
  await waitFor(`document.querySelector('.weapons-table .detail li')`, 'range source');
  await js(`[...document.querySelectorAll('.sort-head')].find((b) => b.textContent.startsWith('Cooldown')).click()`);
  await waitFor(`document.querySelector('th[aria-sort="ascending"]')?.textContent.startsWith('Cooldown')`, 'sorted by cooldown');
  await shot('11-weapons');
  step(`Weapons overview: ER Large Laser up to ${maxRanges[0]} m, sorting and source visible`);

  // Language: switching translates search and mechlab, state is kept, the choice is saved
  const toGerman = `[...document.querySelectorAll('.lang button')].find((b) => b.textContent === 'DE').click()`;
  await send('Page.navigate', { url: `${BASE}/#/mechlab/as7-d` });
  await waitFor(`document.querySelector('.lab-head h2')?.textContent === 'ATLAS AS7-D'`, 'AS7-D');
  await js(`[...document.querySelectorAll('.lab-actions button')].find((b) => b.textContent === 'Max armor').click()`);
  await waitFor(`document.querySelector('.stats').textContent.includes('614 / 614')`, 'max armor');
  const leftovers = await js<string[]>(`(() => {
    const german = /Panzerung|Gewicht|Geschwindigkeit|Waffen|Einbauen|einbauen|Speichern|speichern|Suchen|Kopf|hinten|Technik|Struktur|Kühlung|Hitze|Munition|Ausrüstung|Zurücksetzen/;
    const texts = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) if (german.test(walk.currentNode.textContent)) texts.push(walk.currentNode.textContent);
    return texts;
  })()`);
  assert.deepEqual(leftovers, [], 'German leftovers in the English UI');
  await js(toGerman);
  await waitFor(`document.documentElement.lang === 'de' && [...document.querySelectorAll('.topbar nav a')].some((a) => a.textContent === 'Quirk-Suche')`, 'German navigation');
  assert.equal(await stat('Gewicht'), `${await js<string>(`document.querySelectorAll('.stat-value')[0].textContent`)}`);
  assert.match(await stat('Geschwindigkeit'), /^48,6 km\/h$/);
  assert.match(await stat('Waffen'), /^7 \/ 16$/);
  assert.ok(await js<boolean>(`document.querySelector('.stats').textContent.includes('614 / 614')`), 'armor is kept when switching');
  await shot('9-german-mechlab');
  step('Language: mechlab in German, state is kept');

  await send('Page.navigate', { url: `${BASE}/#/search` });
  await waitFor(`[...document.querySelectorAll('.presets button')].some((b) => b.textContent === 'Bestes AMS-Setup')`, 'German presets');
  await clickText('.presets button', 'Bestes AMS-Setup');
  await waitFor(`document.querySelectorAll('.results-table .row').length > 50`, 'German results');
  await shot('10-german-search');
  await js('window.__beforeReload = true');
  await send('Page.reload');
  await waitFor(`!window.__beforeReload && [...document.querySelectorAll('.topbar nav a')].some((a) => a.textContent === 'Quirk-Suche') && document.querySelector('.lang button')`, 'language kept after reload');
  await js(`[...document.querySelectorAll('.lang button')].find((b) => b.textContent === 'EN').click()`);
  await waitFor(`[...document.querySelectorAll('.topbar nav a')].some((a) => a.textContent === 'Quirk search')`, 'back to English');
  step('Language: search in German, choice is saved, back to English');

  // Narrow view: no horizontal page scrollbar
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/#/mechlab/as7-d` });
  await waitFor(`document.querySelector('.comp-grid')`, 'narrow mechlab');
  await sleep(200);
  const overflow = await js<number>('document.documentElement.scrollWidth - innerWidth');
  await shot('7-narrow');
  assert.ok(overflow <= 0, `page scrolls horizontally by ${overflow}px`);
  step('Narrow view without horizontal scrolling');

  assert.deepEqual(consoleErrors, [], 'no errors in the console');
  step('No console errors');
} catch (e) {
  failed = true;
  console.error(`✖ ${(e as Error).message}`);
  if (consoleErrors.length) console.error('Console:', consoleErrors.slice(0, 5));
} finally {
  console.log(`Screenshots: ${shots}`);
  ws.close();
  stopProcess(chrome);
  servers.forEach(stopProcess);
  await sleep(400);
  for (const dir of [profile, sandbox]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* processes may still hold files */ }
  }
}
process.exit(failed ? 1 : 0);
