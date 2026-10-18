// test/mota/ — 协同共竞 as a trusted match plugin (entry.match): the plugin loads through the registry, its rules run
// against a live Match, and every intent arrives on the generic `p.msg` channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../../shared/constants.js';
import { GameData } from '../../server/match/gamedata.js';
import { readPluginFolder } from '../../server/plugins/registry.js';
import { matchFactoriesOf, preloadMatchModules } from '../../server/plugins/matchPlugins.js';
import { DATA, makeMatch } from '../match/harness.js';
import { economyRules, motaBlock, revivalRules } from '../../plugins/mota-coop/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'mota-coop');
const ID = 'mota-coop';

/** The plugin record as the registry sees it once the owner pinned it (the pin gate itself is upstream's). */
async function loadPlugin() {
  const { plugin, problems } = readPluginFolder(PLUGIN, { dataDir: path.join(ROOT, 'data') });
  assert.deepEqual(problems, [], 'the plugin folder is valid');
  assert.equal(plugin.script.lockValid, true, 'plugin.lock.json matches every byte');
  plugin.status = 'loaded';
  plugin.disabled = null;
  const registry = { plugins: () => [plugin] };
  await preloadMatchModules(registry);
  assert.ok(plugin.match && plugin.match.activate, `match entry loaded (${JSON.stringify(plugin.match)})`);
  return matchFactoriesOf([plugin]);
}

const send = (h, from, type, body) => h.m.handle(from, { t: 'p.msg', plugin: ID, type, body });

test('rules: only a mode with a `mota` block turns the rule set on, and never in solo', () => {
  const gd = new GameData(DATA, 'mode_xie_normal');
  assert.ok(gd.mode && gd.mode.mota, 'data/config.json ships mode_xie_normal with a mota block');
  assert.ok(motaBlock({ mode: gd.mode, isSolo: false }));
  const e = economyRules({ mode: gd.mode, isSolo: false });
  assert.equal(e.transfer.maxPerRequest, 1);
  assert.equal(e.transfer.requestsPerRound, 4);
  assert.equal(e.transfer.teamCapPerRound, 8);
  assert.equal(e.transfer.ttlSec, 30);
  assert.equal(e.transfer.repayInterest, 0);
  assert.equal(e.relief.enabled, true);
  assert.deepEqual(Object.keys(e.projects).sort(), ['logistics', 'storehouse'], '联合采购 is not sold');
  assert.deepEqual(revivalRules({ mode: gd.mode, isSolo: false }), { costPer: 5, step: 5 });
  const vanilla = new GameData(DATA, 'mode_multi_normal');
  assert.equal(economyRules({ mode: vanilla.mode, isSolo: false }), null);
  assert.equal(economyRules({ mode: gd.mode, isSolo: true }), null);
  assert.equal(revivalRules({ mode: vanilla.mode, isSolo: false }), null);
});

test('the plugin loads from its folder, lock and all, and stays out of a vanilla room', async () => {
  const factories = await loadPlugin();
  assert.equal(factories.length, 1);
  assert.equal(factories[0].id, ID);
  // a room whose mode carries no mota block: activate returns null, so the match has no plugin frames
  const v = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, matchPlugins: factories, seed: 3 }).start();
  v.toPrep(1);
  assert.equal(v.m.publicView().econ, undefined);
  assert.equal(v.m.players.get('p_0').privateView().econ, undefined);
  v.m.dispose();
});

test('a xie room runs the economy; the intents arrive on p.msg', async () => {
  const factories = await loadPlugin();
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, modeId: 'mode_xie_normal', matchPlugins: factories, seed: 5 }).start();
  h.toPrep(1);
  const [p1, p2] = [h.m.players.get('p_0'), h.m.players.get('p_1')];
  assert.ok(h.m.publicView().econ, 'm.public carries the plugin view');
  assert.equal(p1.privateView().econ.requestLeft, 4);
  p1.funds = 5; p2.funds = 5;
  assert.equal(send(h, 'p_0', 'g.econ.request', { to: 'p_1', amount: 2 }).error, 'BAD_TARGET', '2 is over maxPerRequest 1');
  assert.equal(send(h, 'p_0', 'g.econ.request', { to: 'p_1', amount: 1 }).ok, true);
  const id = [...h.m.econRequests.keys()][0];
  assert.ok(id, 'a request is in flight');
  assert.equal(send(h, 'p_1', 'g.econ.respond', { id, approve: true }).ok, true);
  assert.equal(p1.funds, 6, 'the borrower received 1');
  assert.equal(p2.funds, 4, 'the lender paid 1');
  assert.equal(h.m.teamReserve, 0, 'a loan never touches the team reserve');
  assert.equal((h.m.econDebts.get('p_0') || []).length, 1, 'the debt is on the ledger');
  // another plugin's message is not this plugin's to answer
  assert.equal(h.m.handle('p_0', { t: 'p.msg', plugin: 'someone-else', type: 'g.econ.relief' }).error, 'BAD_MSG');
  h.m.dispose();
});

test('reserve: prep end converts the leftover above the keep, at most convertPerPlayerMax', async () => {
  const factories = await loadPlugin();
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, modeId: 'mode_xie_normal', matchPlugins: factories, seed: 7 }).start();
  h.toPrep(1);
  const p1 = h.m.players.get('p_0');
  p1.funds = 9;
  h.m.pluginPrepEnd([p1]);
  assert.equal(h.m.teamReserve, 2, 'convertPerPlayerMax is 2');
  assert.equal(p1.funds, 7);
  h.m.dispose();
});

test('revival: LP 0 is held instead of eliminated; full consent pays the pool and revives at 1 LP', async () => {
  const factories = await loadPlugin();
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, modeId: 'mode_xie_normal', matchPlugins: factories, seed: 11 }).start();
  h.toPrep(1);
  const [p1, p2] = [h.m.players.get('p_0'), h.m.players.get('p_1')];
  h.m.phase = PHASE.SETTLE;
  h.m.teamReserve = 20;
  p1.lp = 0;
  h.m.eliminateBroken();
  assert.equal(p1.alive, false);
  assert.equal(p1.pendingDeath, true, 'held at 0 LP, not eliminated');
  assert.ok(h.m.publicView().revival, 'm.public.revival is published by the plugin');
  assert.ok(h.m.pluginSettleHoldMs() > 0, 'the settle phase holds for the window');
  assert.equal(send(h, 'p_1', 'g.revive', { playerId: 'p_0', round: h.m.round }).ok, true);
  assert.equal(p1.alive, true);
  assert.equal(p1.lp, 1, 'rescued with 1 LP');
  assert.equal(h.m.teamReserve, 15, '5 paid out of the shared pool for one voter');
  assert.equal(h.m.pluginSettleHoldMs(), 0, 'nothing pending: the official delay applies again');
  h.m.dispose();
});

test('revival expiry: the held player is eliminated when the window closes', async () => {
  const factories = await loadPlugin();
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, modeId: 'mode_xie_normal', matchPlugins: factories, seed: 13 }).start();
  h.toPrep(1);
  const p1 = h.m.players.get('p_0');
  h.m.phase = PHASE.SETTLE;
  h.m.teamReserve = 20;
  p1.lp = 0;
  h.m.eliminateBroken();
  assert.equal(p1.pendingDeath, true);
  h.m.pluginPhaseExpired('settle');
  assert.equal(p1.pendingDeath, false);
  assert.equal(p1.alive, false);
  h.m.dispose();
});
