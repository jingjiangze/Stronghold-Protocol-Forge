// test/plugins/ui-slots.test.js — the mount points a content panel can declare (UI_SLOT_IDS).
// The content's nine slots are now first-class; the original four stay accepted, and two of the new names are the same
// place under an older one (UI_SLOT_ALIASES). Every slot that is not an alias must have a real host element somewhere
// in the client, or a panel declaring it would silently never mount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_SLOT_ALIASES, UI_SLOT_IDS, UI_SLOT_REPEATABLE } from '../../shared/plugins/manifest.js';
import { createSlotTable } from '../../shared/plugins/ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENT_SLOTS = ['root.overlays', 'root.guide', 'screen.game.aside', 'screen.result.footer',
  'screen.game.shopCard', 'screen.game.bondStrip', 'screen.game.hud', 'screen.game.overlay', 'screen.loadout.detail'];

/** Every `data-ui-slot="…"` a client file renders. */
function hostSlots() {
  const found = new Set();
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) { walk(abs); continue; }
      if (!name.endsWith('.js')) continue;
      const text = fs.readFileSync(abs, 'utf8');
      for (const m of text.matchAll(/data-ui-slot="([^"]+)"/g)) found.add(m[1]);
    }
  };
  walk(path.join(ROOT, 'public', 'js'));
  return found;
}

test('the slot list carries the content\'s nine, and the original four stay accepted', () => {
  for (const s of CONTENT_SLOTS) assert.ok(UI_SLOT_IDS.includes(s), `UI_SLOT_IDS has ${s}`);
  for (const s of ['hud.right', 'result.tab', 'stats.tab', 'room.panel']) assert.ok(UI_SLOT_IDS.includes(s), `UI_SLOT_IDS keeps ${s}`);
  assert.equal(UI_SLOT_IDS.length, 13, '4 original + 9 content');
  assert.equal(new Set(UI_SLOT_IDS).size, UI_SLOT_IDS.length, 'no duplicates');
});

test('aliases point at a real slot and exist to explain the duplicate placement', () => {
  for (const [from, to] of Object.entries(UI_SLOT_ALIASES)) {
    assert.ok(UI_SLOT_IDS.includes(from), `${from} is a slot`);
    assert.ok(UI_SLOT_IDS.includes(to), `${to} is a slot`);
    assert.notEqual(from, to);
  }
  assert.deepEqual(Object.keys(UI_SLOT_ALIASES).sort(), ['screen.game.hud', 'screen.result.footer']);
});

test('every non-aliased slot has a host element in the client, and every alias target does too', () => {
  const hosts = hostSlots();
  for (const slot of UI_SLOT_IDS) {
    if (UI_SLOT_ALIASES[slot]) continue; // mounts into the target's element
    assert.ok(hosts.has(slot), `no [data-ui-slot="${slot}"] host in public/js`);
  }
  for (const to of Object.values(UI_SLOT_ALIASES)) assert.ok(hosts.has(to), `no host for alias target ${to}`);
});

test('the contract file lists exactly the slots the code accepts', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'ui.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.slot.enum, [...UI_SLOT_IDS]);
});

test('a repeatable slot takes several holders; every other slot still takes one', () => {
  assert.ok(UI_SLOT_REPEATABLE.length >= 1);
  for (const s of UI_SLOT_REPEATABLE) assert.ok(UI_SLOT_IDS.includes(s), `${s} is a declared slot`);
  const table = createSlotTable();
  // the shop card is rendered once per card: two plugins may both hold it
  assert.deepEqual(table.request('a', 'screen.game.shopCard', ['screen.game.shopCard']), { ok: true, slot: 'screen.game.shopCard' });
  assert.deepEqual(table.request('b', 'screen.game.shopCard', ['screen.game.shopCard']), { ok: true, slot: 'screen.game.shopCard' });
  assert.deepEqual(table.holders('screen.game.shopCard').sort(), ['a', 'b']);
  assert.equal(table.holder('screen.game.shopCard'), null, 'a repeatable slot has no single holder');
  assert.equal(table.isRepeatable('screen.game.shopCard'), true);
  table.release('a');
  assert.deepEqual(table.holders('screen.game.shopCard'), ['b']);
  table.release('b');
  assert.deepEqual(table.holders('screen.game.shopCard'), []);
  // a single-holder slot is unchanged
  assert.equal(table.request('a', 'hud.right', ['hud.right']).ok, true);
  assert.equal(table.request('b', 'hud.right', ['hud.right']).error, 'PLUGIN_SLOT');
  assert.equal(table.holder('hud.right'), 'a');
  assert.deepEqual(table.holders('hud.right'), ['a']);
  // moving a plugin off a repeatable slot drops it from that set
  table.request('c', 'screen.game.shopCard', ['screen.game.shopCard']);
  table.request('c', 'screen.game.aside', ['screen.game.aside']);
  assert.deepEqual(table.holders('screen.game.shopCard'), []);
});

test('the shop bar renders one host per card, each with its own host key', () => {
  const shop = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ui', 'shopBar.js'), 'utf8');
  assert.match(shop, /data-ui-slot="screen\.game\.shopCard"/);
  assert.match(shop, /data-ui-host-key=\$\{key\}/, 'the host carries the key the panel learns its card from');
  assert.match(shop, /cardSlot\(`c\$\{i\}`\)/, 'one host per chess card');
  assert.match(shop, /cardSlot\(`i\$\{i\}`\)/, 'and one per item card');
});
