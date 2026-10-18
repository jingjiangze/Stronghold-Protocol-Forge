// test/mota/bounty.test.js — 赏金加时 (g.econ.bounty): buy prep time out of the team reserve.
// The plugin (plugins/mota-coop) owns the rule; the match only re-arms its own prep timeout with the extended clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPluginFolder } from '../../server/plugins/registry.js';
import { matchFactoriesOf, preloadMatchModules } from '../../server/plugins/matchPlugins.js';
import { makeMatch } from '../match/harness.js';
import { ECON_BOUNTY } from '../../plugins/mota-coop/economy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function loadPlugin() {
  const { plugin, problems } = readPluginFolder(path.join(ROOT, 'plugins', 'mota-coop'), { dataDir: path.join(ROOT, 'data') });
  assert.deepEqual(problems, []);
  assert.equal(plugin.script.lockValid, true, 'plugin.lock.json matches every byte (re-run node tools/plugin.mjs pack after editing)');
  plugin.status = 'loaded';
  await preloadMatchModules({ plugins: () => [plugin] });
  return matchFactoriesOf([plugin]);
}

const send = (h, from, type, body = {}) => h.m.handle(from, { t: 'p.msg', plugin: 'mota-coop', type, body });

test('a buy costs 4 then 6 then 8, extends the clock by 20 s each, and stops at three', async () => {
  const factories = await loadPlugin();
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, modeId: 'mode_xie_normal', matchPlugins: factories, seed: 21 }).start();
  h.toPrep(1);
  h.m.teamReserve = 40;
  const before = h.m.deadline;
  assert.ok(before > 0, 'a co-op prep is timed');

  const first = send(h, 'p_0', 'g.econ.bounty');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(h.m.teamReserve, 36, 'the first buy costs 4');
  assert.equal(h.m.deadline - before, ECON_BOUNTY.seconds * 1000, 'the deadline is extended, not reset');

  const second = send(h, 'p_1', 'g.econ.bounty');
  assert.equal(second.ok, true);
  assert.equal(h.m.teamReserve, 30, 'the second buy costs 6');
  const third = send(h, 'p_0', 'g.econ.bounty');
  assert.equal(third.ok, true);
  assert.equal(h.m.teamReserve, 22, 'the third buy costs 8');
  const fourth = send(h, 'p_0', 'g.econ.bounty');
  assert.equal(fourth.error, 'ALREADY');
  assert.equal(h.m.teamReserve, 22, 'nothing was charged');
  h.m.dispose();
});

test('refusals carry the reason: the pool cannot pay, a ready player, an untimed prep', async () => {
  const factories = await loadPlugin();
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, modeId: 'mode_xie_normal', matchPlugins: factories, seed: 22 }).start();
  h.toPrep(1);
  h.m.teamReserve = 3;
  const poor = send(h, 'p_0', 'g.econ.bounty');
  assert.equal(poor.error, 'NO_FUNDS');
  assert.equal(poor.detail, 'reserve');
  h.m.teamReserve = 40;
  h.m.players.get('p_1').setReady(true);
  const ready = send(h, 'p_1', 'g.econ.bounty');
  assert.equal(ready.error, 'WRONG_PHASE');
  assert.equal(ready.detail, 'ready');
  const untimed = (() => { h.m.deadline = 0; return send(h, 'p_0', 'g.econ.bounty'); })();
  assert.equal(untimed.detail, 'untimed');
  h.m.dispose();
});

test('the private view tells the client the next price, how many are left and whether the pool can pay', async () => {
  const factories = await loadPlugin();
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, modeId: 'mode_xie_normal', matchPlugins: factories, seed: 23 }).start();
  h.toPrep(1);
  const p = h.m.players.get('p_0');
  h.m.teamReserve = 5;
  assert.deepEqual(p.privateView().econ.bounty, { left: 3, cost: 4, seconds: 20, affordable: true });
  send(h, 'p_0', 'g.econ.bounty');
  assert.deepEqual(p.privateView().econ.bounty, { left: 2, cost: 6, seconds: 20, affordable: false });
  h.m.teamReserve = 10;
  assert.equal(p.privateView().econ.bounty.affordable, true);
  h.m.dispose();
});
