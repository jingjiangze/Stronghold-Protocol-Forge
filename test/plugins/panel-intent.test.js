// test/plugins/panel-intent.test.js — the content panel → server intent channel (shared/plugins/ui.js `intent`).
// A panel may ask for a gameplay action (g.*) or for its own match plugin (p.msg); room.*, b.*, hello/ping and any
// second intent stay refused. The frame host binds `p.msg.plugin` to the panel's own plugin id (pluginFrame.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isPanelIntentType, validatePluginMessage } from '../../shared/plugins/ui.js';

const intent = (msg) => ({ v: 1, t: 'intent', msg });

test('a panel may ask for a gameplay intent or for its own p.msg', () => {
  assert.equal(isPanelIntentType('g.buy'), true);
  assert.equal(isPanelIntentType('g.econ.request'), true);
  assert.equal(isPanelIntentType('p.msg'), true);
  for (const t of ['room.setPlugins', 'b.result', 'hello', 'ping', 'welcome', 'ready']) assert.equal(isPanelIntentType(t), false, t);

  const buy = validatePluginMessage(intent({ t: 'g.buy', slot: 3 }));
  assert.equal(buy.ok, true, JSON.stringify(buy));
  assert.deepEqual(buy.msg, { v: 1, t: 'intent', msg: { t: 'g.buy', slot: 3 } });

  const econ = validatePluginMessage(intent({ t: 'p.msg', type: 'g.econ.request', body: { to: 'p_1', amount: 1 } }));
  assert.equal(econ.ok, true, JSON.stringify(econ));
  assert.equal(econ.msg.msg.type, 'g.econ.request');
});

test('room lifecycle, battle reports and the handshake stay refused', () => {
  for (const t of ['room.create', 'room.setPlugins', 'room.start', 'b.result', 'b.progress', 'hello', 'ping', 'unknown']) {
    const r = validatePluginMessage(intent({ t }));
    assert.equal(r.ok, false, t);
    assert.equal(r.reason, 'intent', t);
  }
});

test('a message may carry one intent only, and a p.msg body may not smuggle another', () => {
  // a second intent-typed KEY (not the message's own t)
  const extra = validatePluginMessage(intent({ t: 'g.buy', 'g.sell': { uid: 1 } }));
  assert.equal(extra.ok, false);
  assert.equal(extra.reason, 'intent');
  // a p.msg whose body is an intent
  const smuggled = validatePluginMessage(intent({ t: 'p.msg', type: 'x', body: { t: 'g.buy', slot: 0 } }));
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.reason, 'intent');
  // extra top-level keys are a shape problem, not an intent
  const shape = validatePluginMessage({ v: 1, t: 'intent', msg: { t: 'g.buy' }, extra: 1 });
  assert.equal(shape.reason, 'shape');
  assert.equal(validatePluginMessage({ v: 1, t: 'intent' }).reason, 'shape');
  assert.equal(validatePluginMessage({ v: 1, t: 'intent', msg: {} }).reason, 'intent');
});

test('the ordinary panel messages are unchanged: a bare g.* is still refused', () => {
  assert.equal(validatePluginMessage({ v: 1, t: 'g.buy', slot: 0 }).reason, 'intent');
  assert.equal(validatePluginMessage({ v: 1, t: 'storage', op: 'keys' }).ok, true);
  assert.equal(validatePluginMessage({ v: 1, t: 'ready', nested: { t: 'g.buy' } }).reason, 'intent');
});

test('the contract file lists the intent message', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../../schemas/ui.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.$defs.panelIntent, 'schemas/ui.schema.json has a panelIntent definition');
  assert.equal(schema.$defs.panelIntent.properties.t.const, 'intent');
  assert.ok(schema.$defs.panelIntent.properties.msg.properties.t.pattern.includes('g\\.'), 'the pattern allows g.*');
  assert.ok(schema.$defs.panelIntent.properties.msg.properties.t.pattern.includes('p\\.msg'), 'and p.msg');
  assert.ok(schema.$defs.pluginToHost.oneOf.some((r) => r.$ref === '#/$defs/panelIntent'), 'and lists it');
});
