// test/match/confront-limits.test.js — the bounds of a 4V4 / stacked 狩猎期 (PR #24 leftovers):
//   ① an attacker never ends up without a target when the team outnumbers the live opponents (it stacks);
//   ② the round's replacement share belongs to the RECEIVER — N attackers split it, not multiply it;
//   ③ a placement never eats another attacker's monsters;
//   ④ the live-phase bounty has a ceiling (one round's income).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch } from './harness.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { VERSUS_CONFRONT } from '../../shared/constants.js';

/** A versus match parked at the drawn contest round, inside PREP, with this round's wave built. */
function ready(teamSize = 4, humans = 8) {
  const h = makeMatch({ mode: 'versus', difficulty: 'NORMAL', humans, bots: 0, seed: 7, fake: true, teamSize });
  const m = h.m;
  const band = Object.keys(DATA.bands)[0];
  for (const ps of m.order) ps.bandId = band;
  m.initTeamHp();
  m.round = m.contestStartRound;
  m.phase = 'PREP';
  m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, m.round);
  return m;
}

/** Every attacker of team 0 gets a target, even when the opponents are down to two. */
test('confront: an outnumbered opponent still receives every attacker (a stack, never a dropped placement)', () => {
  const m = ready(4, 8);
  // two of the four opponents are eliminated
  const opps = m.order.filter((ps) => m.teamIdOf(ps) === 1);
  opps[2].alive = false;
  opps[3].alive = false;
  m.enterConfront();
  for (const ps of m.order.filter((p) => m.teamIdOf(p) === 0)) m.assignConfrontTarget(ps, null, true);

  const attackers = m.order.filter((ps) => m.teamIdOf(ps) === 0);
  for (const ps of attackers) {
    const t = m.confrontTargets.get(ps.playerId);
    assert.ok(t, `${ps.playerId} has a target`);
    assert.ok(opps.slice(0, 2).some((o) => o.playerId === t), 'and it is a live opponent');
  }
  // the 4 attackers are spread 2/2 over the 2 live opponents (least-attacked first)
  const loads = opps.slice(0, 2).map((o) => attackers.filter((a) => m.confrontTargets.get(a.playerId) === o.playerId).length);
  assert.deepEqual(loads, [2, 2]);
});

/** Two placements aimed at `receiver`, built by hand (the state a finished 对抗期 hands to combat). */
function twoOnOne(m, receiverId = 'p_4') {
  const receiver = m.players.get(receiverId);
  const budget = m.confrontBudget();
  const rows = m.confrontGroups().flatMap((g) => g.rows)
    .filter((r) => r.value > 0 && r.value <= budget)
    .sort((a, b) => a.value - b.value || String(a.key).localeCompare(String(b.key)));
  assert.ok(rows.length >= 2, 'this round offers two affordable monsters');
  const mk = (attackerId, pick) => ({
    target: receiverId, group: 1, position: 'mid',
    picks: [{ enemyKey: pick.key, gate: 'lower' }], bosses: [],
    total: 1, ratio: m.confrontRatio(), budget, seat: m.players.get(attackerId).seat,
  });
  m.confront = new Map([
    ['p_0', mk('p_0', rows[0])],
    ['p_1', mk('p_1', rows[rows.length - 1])],
  ]);
  assert.equal(m.confrontFor(receiver).length, 2, 'the receiver takes two placements');
  return { receiver, budget };
}

test('confront: N attackers on one receiver split the round’s share instead of multiplying it', () => {
  const m = ready(4, 8);
  m.enterConfront();
  const { receiver } = twoOnOne(m);
  const p4 = receiver;

  const wave = m.confrontWaveValue();
  const valueOf = (key) => m.confrontValueOf(key);
  const before = m.wave.spawns.reduce((n, s) => n + (Number(s.count) || 1), 0);
  const valueBefore = m.wave.spawns.reduce((n, s) => n + (Number(s.count) || 1) * valueOf(s.enemyKey), 0);
  const subs = m.confrontFor(p4);
  let list = m.wave.spawns.map((s) => ({ ...s, ownerPlayerId: p4.playerId }));
  for (const sub of subs) list = m.applyConfront(list, sub, p4);
  const valueAfter = list.filter((s) => s.confrontPlaced !== true)
    .reduce((n, s) => n + (Number(s.count) || 1) * valueOf(s.enemyKey), 0);
  const removed = valueBefore - valueAfter;
  const share = wave * m.confrontRatio();
  // each of the two splits the share (ratio/2); the greedy pick lands within ~2 % of its target
  assert.ok(removed > 0, 'something was replaced');
  assert.ok(removed <= share * 1.05, `replaced ${removed} > one round's share ${share}`);
  assert.ok(removed >= share * 0.45, `replaced ${removed} is far below half the share ${share}`);
  assert.ok(before > 0);
});

test('confront: a second placement never removes the first attacker’s monsters', () => {
  const m = ready(4, 8);
  m.enterConfront();
  const { receiver: p4 } = twoOnOne(m);
  const [a, b] = m.confrontFor(p4);
  const wave = m.wave.spawns.map((s) => ({ ...s, ownerPlayerId: p4.playerId }));
  const afterFirst = m.applyConfront(wave, a, p4);
  const placedFirst = afterFirst.filter((s) => s.confrontPlaced === true).map((s) => s.enemyKey);
  assert.ok(placedFirst.length > 0, 'the first placement is in the list');
  const afterSecond = m.applyConfront(afterFirst, b, p4);
  const stillThere = afterSecond.filter((s) => s.confrontPlaced === true).map((s) => s.enemyKey);
  for (const key of placedFirst) {
    assert.ok(stillThere.includes(key), `${key} survived the second placement`);
  }
});

test('confront: the live-phase bounty pays at most one round’s income', () => {
  const m = ready(4, 8);
  // huntIdx 5 → the live formula (contest R4 ⇒ R8). R13 is the fixed 25.
  m.round = m.contestStartRound + 4;
  assert.equal(m.confrontFixedBountyCap(), null, 'this round runs the live formula');
  const income = m.gd.income(m.round);
  assert.ok(income > 0, 'the round pays income');
  // a batch whose value is several times the wave: without the ceiling it would pay > 1 income
  const keys = m.confrontGroups().flatMap((g) => g.rows).slice(0, 8).map((r) => r.key);
  const picks = keys.map((enemyKey) => ({ enemyKey }));
  const wave = m.confrontWaveValue();
  const raw = picks.reduce((n, p) => n + m.confrontValueOf(p.enemyKey), 0) / wave * income;
  assert.ok(raw > income, `the raw formula would pay ${raw} > income ${income}`);
  assert.equal(m.confrontBountyAt(picks.length, picks), income, 'the ceiling is exactly one income');
  assert.ok(VERSUS_CONFRONT.killIncomeShare > 0);
});
