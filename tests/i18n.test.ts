import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyze, componentLabel, formatIssue, formatMessage, formatQuirkValue, formatSource, LOCALES, MESSAGES, quirkLabel, SEARCH_PRESETS, stockBuild,
  WEAPON_QUIRK_STATS, statLabel, type Build, type MessageKey, type Quirk,
} from '@mwo/shared';
import { data, ix } from './helpers.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const allQuirks = (): Quirk[] => [
  ...data.mechs.flatMap((m) => m.quirks),
  ...data.chassis.flatMap((c) => c.sets.flatMap((s) => [...s.bonuses.flatMap((b) => b.quirks), ...Object.values(s.pods).flatMap((p) => p.quirks)])),
  ...data.skills.flatMap((s) => s.effects.map((e) => e.quirk)),
];

test('Both languages have the same keys and placeholders', () => {
  const keys = Object.keys(MESSAGES.en) as MessageKey[];
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), [...keys].sort());
  for (const k of keys) {
    assert.deepEqual(placeholders(MESSAGES.en[k]), placeholders(MESSAGES.de[k]), k);
    assert.ok(MESSAGES.en[k].length > 0 && MESSAGES.de[k].length > 0, k);
  }
});

test('Rule messages follow the language and translate components', () => {
  const b: Build = structuredClone(stockBuild('as7-d', ix));
  b.armor['head'] = 19;
  const issue = analyze(b, ix).issues.find((i) => i.code === 'armor')!;
  assert.equal(formatIssue(issue, 'de'), 'Kopf: 19 Panzerung, maximal 18.');
  assert.equal(formatIssue(issue, 'en'), 'Head: 19 armor, maximum 18.');
});

test('Number format follows the language', () => {
  assert.equal(formatQuirkValue({ kind: 'additive', value: 1.5 }, 'de'), '+1,5');
  assert.equal(formatQuirkValue({ kind: 'additive', value: 1.5 }, 'en'), '+1.5');
  assert.equal(formatQuirkValue({ kind: 'multiplier', value: -0.075 }, 'de'), '-7,5%');
  assert.equal(formatMessage('de', 'issue.overweight', { used: 100.5, max: 100 }), '100,5 t, erlaubt sind 100 t.');
  assert.equal(formatMessage('en', 'issue.overweight', { used: 100.5, max: 100 }), '100.5 t, the limit is 100 t.');
});

test('Quirk sources in both languages', () => {
  assert.equal(formatSource({ kind: 'set', set: 'kfx-c', pieces: 8 }, 'de'), 'Set-Bonus KFX-C (8 Teile)');
  assert.equal(formatSource({ kind: 'set', set: 'kfx-c', pieces: 8 }, 'en'), 'Set bonus KFX-C (8 pieces)');
  assert.equal(formatSource({ kind: 'pod', set: 'kfx-c', component: 'head' }, 'de'), 'Pod KFX-C (Kopf)');
  assert.equal(formatSource({ kind: 'pod', set: 'kfx-c', component: 'head' }, 'en'), 'Pod KFX-C (Head)');
  assert.equal(componentLabel('centre_torso_rear', 'en'), 'CT rear');
});

test('Every quirk has a readable label in both languages', () => {
  const german = /Panzerung|Hitze|Kühlung|Reichweite|Schaden|Munition|Struktur|Alle Waffen|Kopf/;
  const quirks = new Map(allQuirks().map((q) => [q.key, q]));
  for (const [key, q] of quirks) {
    for (const locale of LOCALES) {
      const label = quirkLabel(q, locale);
      assert.ok(label.length > 0, `${key}/${locale}`);
      assert.ok(!/_(multiplier|additive)$/.test(label), `raw name ${label}`);
    }
    assert.ok(!german.test(quirkLabel(q, 'en')), `German in English: ${key} → ${quirkLabel(q, 'en')}`);
  }
  const get = (key: string) => quirks.get(key)!;
  assert.equal(quirkLabel(get('heatdissipation_multiplier'), 'de'), 'Kühlung');
  assert.equal(quirkLabel(get('armorresist_ct_additive'), 'de'), 'CT: Panzerung');
  assert.equal(quirkLabel(get('armorresist_ct_additive'), 'en'), 'CT: Armor');
  assert.equal(quirkLabel(get('all_cooldown_multiplier'), 'de'), 'Alle Waffen: Cooldown');
});

test('Search presets and stats exist in both languages', () => {
  for (const p of SEARCH_PRESETS) {
    for (const l of LOCALES) assert.ok(p.label[l] && p.description[l], `${p.id}/${l}`);
  }
  for (const s of WEAPON_QUIRK_STATS) {
    for (const l of LOCALES) assert.notEqual(statLabel(s, l), s === 'cooldown' ? '' : s, `${s}/${l}`);
  }
});
