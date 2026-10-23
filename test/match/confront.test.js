// test/match/confront.test.js — the 2V2 对抗期 state machine (server/match/match/confront.js):
//   targets (g.confrontTarget) → monsters (g.confront) → 悬赏名单 roster → COMBAT, the per-round budget / ratio ramp,
//   the kill-bounty table and 坎诺特's withdrawal (g.confront.withdraw).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch } from './harness.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { VERSUS_CONFRONT, merchantRateFor, merchantCapFor } from '../../shared/constants.js';

/** A 2V2 match parked at the drawn contest round, inside PREP, with this round's wave built. */
function confrontReady() {
  const h = makeMatch({ mode: 'versus', difficulty: 'NORMAL', humans: 4, bots: 0, seed: 7, fake: true });
  const m = h.m;
  const band = Object.keys(DATA.bands)[0];
  for (const ps of m.order) ps.bandId = band;
  m.initTeamHp();
  m.round = m.contestStartRound;
  m.phase = 'PREP';
  m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, m.round);
  return { h, m };
}

/** The cheapest rows of the round's four offered types that together stay inside the budget. */
function affordable(m, n = 2) {
  const budget = m.confrontBudget();
  const rows = m.confrontGroups().flatMap((g) => g.rows.map((r) => ({ ...r, group: g.id })));
  const picks = rows.filter((r) => r.value > 0 && r.value <= budget)
    .sort((a, b) => a.value - b.value || String(a.key).localeCompare(String(b.key)))
    .slice(0, n);
  return { group: picks[0] ? m.confrontGroups().findIndex((g) => g.id === picks[0].group) + 1 : 1, picks };
}

test('confront: only a versus match from the drawn contest round runs the 对抗期', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 7, fake: true });
  const m = h.m;
  assert.equal(m.isVersus, false);
  assert.equal(m.coopHuntOn, true, 'co-op runs 同盟狩猎 by default');
  assert.equal(m.confrontActive(), false, 'the 2V2 对抗期 never runs in co-op');

  const { m: v } = confrontReady();
  v.round = v.contestStartRound - 1;
  assert.equal(v.confrontActive(), false, 'not before the drawn round');
  v.round = v.contestStartRound;
  assert.equal(v.confrontActive(), true);
  v.round = v.gd.bossRound;
  assert.equal(v.confrontActive(), false, 'never on a boss round');
});

test('confront: ratio ramp is 5 % at the drawn round, +2 %/round, capped at 15 %, flat 50 % at R13', () => {
  const { m } = confrontReady();
  const first = m.contestStartRound;
  const cases = [[first, 0.05], [first + 1, 0.07], [first + 2, 0.09], [first + 5, 0.15], [VERSUS_CONFRONT.huntRound, 0.5]];
  for (const [round, want] of cases) {
    m.round = round;
    assert.equal(m.confrontRatio(), want, `R${round}`);
  }
});

test('confront: targets → monsters → roster, and the public view carries the panel', () => {
  const { m } = confrontReady();
  m.enterConfront();
  assert.equal(m.phase, 'CONFRONT');
  assert.equal(m.confrontStage, 'target');

  // a player may only name an OPPONENT
  const p0 = m.players.get('p_0');
  const mate = m.order.find((ps) => m.teamIdOf(ps) === m.teamIdOf(p0));
  assert.equal(m.submitConfrontTarget(p0, { targetPlayerId: mate.playerId }).error, 'BAD_TARGET');

  // one human's pick also fills its TEAMMATE's (first come, first served) — the opponent side decides in the same way
  assert.equal(m.submitConfrontTarget(p0, { targetPlayerId: 'p_2' }).ok, true);
  assert.equal(m.confrontTargets.get('p_1'), 'p_3', 'the teammate is handed the other opponent');
  assert.equal(m.confrontTargets.get('p_0'), 'p_2');
  for (const ps of m.order.filter((p) => m.teamIdOf(p) === 1)) {
    if (m.confrontStage !== 'target') break;
    const opp = m.order.find((o) => m.teamIdOf(o) !== m.teamIdOf(ps));
    const r = m.submitConfrontTarget(ps, { targetPlayerId: opp.playerId });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.equal(m.confrontStage, 'monster', 'every target in ⇒ step 2 opens');
  assert.equal(m.confrontTargets.size, 4);

  const { group, picks } = affordable(m);
  for (const ps of m.order) {
    const r = m.submitConfront(ps, { group, position: 'front', picks: picks.map((p) => ({ enemyKey: p.key, gate: 'lower' })) });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.equal(m.confrontStage, 'roster', 'every submission in ⇒ the 悬赏名单 holds');
  assert.equal(m.confront.size, 4);

  const pv = m.publicView(0);
  assert.equal(pv.confront.stage, 'roster');
  assert.equal(pv.confront.round, m.round);
  assert.equal(pv.confront.budget, m.confrontBudget());
  assert.equal(pv.confront.maxPicks, VERSUS_CONFRONT.maxPicks);
  assert.equal(pv.confront.groups.length, m.confrontGroups().length);
  assert.ok(pv.confront.roster && pv.confront.roster.ms === VERSUS_CONFRONT.rosterMs);
  assert.equal(pv.contestStartRound, m.contestStartRound, 'the drawn round is public');
  assert.deepEqual(pv.merchant, { rate: merchantRateFor(m.round, VERSUS_CONFRONT), cap: VERSUS_CONFRONT.merchantRoundCap });
});

test('confront: an over-budget or over-count placement is refused', () => {
  const { m } = confrontReady();
  m.enterConfront();
  for (const ps of m.order) {
    const opp = m.order.find((o) => m.teamIdOf(o) !== m.teamIdOf(ps));
    m.submitConfrontTarget(ps, { targetPlayerId: opp.playerId });
  }
  const p0 = m.players.get('p_0');
  const budget = m.confrontBudget();
  const expensive = m.confrontGroups().flatMap((g) => g.rows).filter((r) => r.value > budget);
  assert.ok(expensive.length > 0, 'this round offers something above the budget');
  assert.equal(m.submitConfront(p0, { group: 1, position: 'front', picks: [{ enemyKey: expensive[0].key, gate: 'lower' }] }).error, 'CONFRONT_BUDGET');

  const tooMany = Array.from({ length: VERSUS_CONFRONT.maxPicks + 1 }, () => ({ enemyKey: expensive[0].key, gate: 'lower' }));
  assert.equal(m.submitConfront(p0, { group: 1, position: 'front', picks: tooMany }).error, 'CONFRONT_COUNT');
});

test('confront: 坎诺特 priced the bounty by the hunt phase (1 / 1 / 2 / 2, R13 flat 25)', () => {
  const { m } = confrontReady();
  const { picks } = affordable(m, 1);
  assert.equal(picks.length, 1, 'a cheap monster fits this round');
  // huntIdx 1 → the full clear pays cap 1
  assert.equal(m.confrontBountyOf([{ enemyKey: picks[0].key }]), 1);
  // the 最终狩猎 pays its own fixed 25 on a full clear
  const saved = m.round;
  m.round = VERSUS_CONFRONT.huntRound;
  assert.equal(m.confrontBountyOf([{ enemyKey: picks[0].key }]), VERSUS_CONFRONT.finalHuntBounty);
  m.round = saved;
});

test('confront: 坎诺特 withdraws bank → gold at the round rate, ceil first then floor, capped per round', () => {
  const { m } = confrontReady();
  const p0 = m.players.get('p_0');
  m.round = 6;
  m.phase = 'PREP';
  p0.bountyBank = 100;
  p0.withdrawnThisRound = 0;
  assert.equal(m.merchantRate(), merchantRateFor(6, VERSUS_CONFRONT));
  assert.equal(m.merchantCap(), VERSUS_CONFRONT.merchantRoundCap);

  // rate 20 %: 1 gold costs ceil(1/0.2) = 5 on the first withdrawal
  const before = p0.funds;
  assert.equal(m.withdrawBounty(p0, { gold: 1 }).ok, true);
  assert.equal(p0.bountyBank, 95);
  assert.equal(p0.funds, before + 1);
  // the second one floors: 1 gold costs floor(5) = 5
  assert.equal(m.withdrawBounty(p0, { gold: 1 }).ok, true);
  assert.equal(p0.bountyBank, 90);
  // the per-round cap is 4 gold
  assert.equal(m.withdrawBounty(p0, { gold: 3 }).error, 'MERCHANT_CAP');
  // an empty bank refuses
  p0.withdrawnThisRound = 0;
  p0.bountyBank = 0;
  assert.equal(m.withdrawBounty(p0, { gold: 1 }).error, 'MERCHANT_BANK');
  // R15 隐秘核心 is 1:1 and uncapped
  assert.equal(merchantCapFor(VERSUS_CONFRONT.merchantUncappedRound, VERSUS_CONFRONT), Infinity);
  assert.equal(merchantRateFor(VERSUS_CONFRONT.merchantUncappedRound, VERSUS_CONFRONT), 1);
});

test('confront: a coop hunt plans one system placement per alive player and inserts it', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 7, fake: true });
  const m = h.m;
  m.round = m.contestStartRound;
  m.phase = 'PREP';
  m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, m.round);
  assert.equal(m.coopHuntActive(), true);
  const plans = m.coopHuntPlans();
  const alive = m.alivePlayers();
  assert.equal(plans.size, alive.length, 'one plan per alive player');
  for (const ps of alive) {
    const plan = m.coopHuntPlan(ps);
    assert.ok(plan && Array.isArray(plan.picks), `${ps.playerId} has a plan`);
    assert.ok(plan.value <= plan.budget, 'the plan stays inside its budget');
  }
  const ps = alive[0];
  const spawns = m.applyCoopHunt(m.wave.spawns, ps);
  const placed = spawns.filter((s) => s.prey);
  assert.equal(placed.length, m.coopHuntPlan(ps).picks.length, 'every pick is inserted');
  for (const s of placed) {
    assert.equal(s.countInTotal, false, 'a leaked prey costs no 目标生命值');
    assert.equal(s.bounty.bank, true, 'its bounty is banked, never gold');
  }
});
