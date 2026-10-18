// test/plugins/frame-plan.test.js — which slot a panel gets and how many frames it needs (public/js/ui/framePlan.js).
// The browser half (pluginFrame.js) only builds what this returns, so the decisions are testable without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameKeys, planMount } from '../../public/js/ui/framePlan.js';
import { UI_SLOT_REPEATABLE } from '../../shared/plugins/manifest.js';

const isRepeatable = (s) => UI_SLOT_REPEATABLE.includes(s);
const free = () => null;

test('a repeatable slot mounts one frame per host and may be shared by another plugin', () => {
  const hosts = { 'screen.game.shopCard': ['c0', 'c1', 'c2'] };
  const plan = planMount({ declared: ['screen.game.shopCard'], hosts, isRepeatable, holder: free });
  assert.deepEqual(plan, { slot: 'screen.game.shopCard', repeatable: true, keys: ['c0', 'c1', 'c2'] });
  assert.deepEqual(frameKeys('p', plan), ['p#c0', 'p#c1', 'p#c2']);
  // a second plugin gets the same slot although the first holds it: repeatable slots are shared
  const second = planMount({ declared: ['screen.game.shopCard'], hosts, isRepeatable, holder: () => 'p' });
  assert.equal(second.repeatable, true);
  assert.deepEqual(second.keys, ['c0', 'c1', 'c2']);
});

test('one host still mounts (one card in the shop), and a hostless repeatable slot falls through', () => {
  assert.deepEqual(frameKeys('p', planMount({ declared: ['screen.game.shopCard'], hosts: { 'screen.game.shopCard': ['c0'] }, isRepeatable, holder: free })),
    ['p#c0']);
  // no host at all: the repeatable slot is not chosen; the next declared single slot is
  const plan = planMount({ declared: ['screen.game.shopCard', 'hud.right'], hosts: { 'hud.right': [] }, isRepeatable, holder: free });
  assert.deepEqual(plan, { slot: 'hud.right', repeatable: false, keys: [] });
  assert.deepEqual(frameKeys('p', plan), ['p']);
});

test('a single-holder slot: first with a host, else the first free one, else nothing', () => {
  const hosts = { 'hud.right': [''], 'room.panel': [''] };
  assert.equal(planMount({ declared: ['hud.right', 'room.panel'], hosts, isRepeatable, holder: free }).slot, 'hud.right');
  // hud.right is taken: the next declared slot with a host
  assert.equal(planMount({ declared: ['hud.right', 'room.panel'], hosts, isRepeatable, holder: (s) => (s === 'hud.right' ? 'other' : null) }).slot, 'room.panel');
  // nothing has a host: the first free declared slot (mounts parked)
  assert.equal(planMount({ declared: ['stats.tab'], hosts: {}, isRepeatable, holder: free }).slot, 'stats.tab');
  // everything is taken
  assert.equal(planMount({ declared: ['hud.right'], hosts, isRepeatable, holder: () => 'other' }), null);
});

test('undeclared and unknown slots are ignored', () => {
  const hosts = { 'hud.right': [''], nope: [''] };
  assert.equal(planMount({ declared: ['nope'], hosts, isRepeatable, holder: free }), null);
  assert.equal(planMount({ declared: ['hud.right', 'nope'], hosts, isRepeatable, holder: free }).slot, 'hud.right');
  assert.equal(planMount({ declared: [], hosts, isRepeatable, holder: free }), null);
});
