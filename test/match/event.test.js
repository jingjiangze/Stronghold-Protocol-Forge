// test/match/event.test.js — the 2V2 事件期 (server/match/match/event.js): the drawn rounds, the timed pick with the
// four targets and the no-repeat rule, the 词条公示 roster, the entry windows (EVENT_DURATION_ROUNDS) and the monster
// entry's battle refs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch } from './harness.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { EVENT_DURATION_ROUNDS, EVENT_TARGETS, PHASE } from '../../shared/constants.js';
import { eventModsFor, eventBattleRefs } from '../../server/match/match/event.js';

/** A versus match parked on its first event round, inside ROUND_START with the round's wave built. */
function eventReady() {
  const h = makeMatch({ mode: 'versus', difficulty: 'NORMAL', humans: 4, bots: 0, seed: 7, fake: true });
  const m = h.m;
  const band = Object.keys(DATA.bands)[0];
  for (const ps of m.order) ps.bandId = band;
  m.initTeamHp();
  m.round = m.eventRounds[0];
  m.phase = PHASE.ROUND_START;
  m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, m.round);
  return { h, m };
}

test('event: only a hunt mode opens the drawn rounds, once each', () => {
  const coopOff = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 7, fake: true }).m;
  assert.deepEqual(coopOff.eventRounds, [], '同盟狩猎 is off by default');
  const coop = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 7, fake: true, coopHunt: true }).m;
  assert.equal(coop.eventRounds.length, 3, 'a co-op hunt draws the same three rounds');
  coop.round = coop.eventRounds[0];
  assert.equal(coop.eventDue(), true);
  coop._eventDoneRound = coop.round;
  assert.equal(coop.eventDue(), false, 'one period per drawn round');

  const solo = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, bots: 0, seed: 7, fake: true }).m;
  solo.round = 5;
  assert.deepEqual(solo.eventRounds, [], 'solo never has an event');
  assert.equal(solo.eventDue(), false);
});

test('event: enterEvent opens the phase with a monster entry and four targets', () => {
  const { m } = eventReady();
  m.enterEvent();
  assert.equal(m.phase, PHASE.EVENT);
  assert.ok(m.event && m.event.round === m.round);
  assert.ok(m.foeEvent && m.foeEvent.card, 'the period draws one monster entry');

  const view = m.eventView();
  assert.equal(view.ally.active, true);
  assert.deepEqual(view.ally.rounds, m.eventRounds);
  assert.equal(view.ally.index, 1);
  assert.deepEqual(Object.keys(view.ally.targets).sort(), m.order.map((p) => p.playerId).sort());
  for (const ps of m.order) assert.deepEqual(m.eventAvailableTargets(ps), [...EVENT_TARGETS], `${ps.playerId}: all four`);
});

test('event: the four targets, the no-repeat rule, and the recipient gets the entry', () => {
  const { m } = eventReady();
  m.enterEvent();
  const p0 = m.players.get('p_0');
  const mate = m.order.find((p) => p !== p0 && p.team === p0.team);

  assert.equal(m.pickEvent(p0, 'nope').error, 'BAD_TARGET');
  assert.equal(m.pickEvent(p0, 'self').ok, true);
  assert.equal(m.pickEvent(p0, 'mate').error, 'ALREADY', 'one pick per player');

  const rec = m.event.picks.get(p0.playerId);
  assert.equal(rec.target, 'self');
  assert.equal(p0.eventEntries.length, 1, 'self receives its own entry');
  assert.equal(p0.eventEntries[0].mag, 2, 'a self-targeted entry is doubled');
  assert.ok(p0.eventTargets.includes('self'));

  // the target is spent for the whole match, so the next event offers three
  p0.eventTargets.push('mate');
  assert.deepEqual(m.eventAvailableTargets(p0), ['oppA', 'oppB']);
  assert.ok(mate, 'the teammate exists in a 4-seat versus room');
});

test('event: the roster hold ends the phase and the round continues into 机变 / 休整期', () => {
  const { m } = eventReady();
  m.enterEvent();
  for (const ps of m.order) {
    const target = m.eventAvailableTargets(ps)[0];
    assert.equal(m.pickEvent(ps, target).ok, true, ps.playerId);
  }
  assert.equal(m.eventStage, 'roster', 'every pick in ⇒ the 词条公示 holds');
  assert.deepEqual(Object.keys(m.eventView().ally.picks).sort(), m.order.map((p) => p.playerId).sort());
  m.finishEventRoster();
  assert.ok(m.phase === PHASE.SP_DRAFT || m.phase === PHASE.PREP, `continued to ${m.phase}`);
  assert.equal(m._eventDoneRound, m.round, 'the period is spent');
  assert.equal(m.eventDue(), false);
});

test('event: an entry is in force for EVENT_DURATION_ROUNDS rounds and then lapses', () => {
  const entries = [{ card: { id: 1, key: 'whetstone', class: 'output', kind: 'up', atkPct: 0.2 }, mag: 1, from: 'x', round: 6, target: 'self' }];
  assert.ok(eventModsFor(entries, 6).atkPct > 0, 'active on the round it was picked');
  assert.ok(eventModsFor(entries, 6 + EVENT_DURATION_ROUNDS - 1).atkPct > 0, 'still active on the last window round');
  assert.equal(eventModsFor(entries, 6 + EVENT_DURATION_ROUNDS).atkPct, 0, 'lapsed after the window');
  assert.equal(eventBattleRefs(entries, 6 + EVENT_DURATION_ROUNDS).length, 0, 'the battle sees no ref either');
  assert.equal(eventBattleRefs(entries, 6).length, 1);
});

test('event: the monster entry marks the round’s normal wave only', () => {
  const { m } = eventReady();
  m.enterEvent();
  const plain = buildNormalWave(m.gd, m.rngWaves, m.factions, m.round).spawns;
  const after = m.foeWaveSpawns(plain);
  const card = m.foeEvent.card;
  // a spawn row may be SPLIT (the 强力属性 subset marks e of its c bodies) but never dropped outright
  assert.ok(after.length >= plain.length, 'the entry never drops a spawn row');
  const stats = card.hpMul || card.atkMul || card.defMul || card.speedMul;
  if (stats) {
    const touched = after.filter((s) => s.elite || (s.mods && (s.mods.hpMul !== 1 || s.mods.atkMul !== 1))).length;
    assert.ok(touched > 0, 'the entry’s stat multipliers reach the wave');
  }
  // the count side (增援 / 稀疏) never touches a 赏金 spawn
  for (const s of after) if (s.tag === 'bounty') assert.equal(s.count, plain.find((p) => p.enemyKey === s.enemyKey)?.count ?? s.count);
  // the 强力属性 subset is public and bounded by the wave's own monster count
  const elite = m.publicFoeElite();
  if (elite) {
    assert.ok(elite.share > 0 && elite.share <= 0.25);
    assert.ok(elite.count >= 1);
    assert.ok(['fangs', 'thick_hide', 'hard_shell', 'swift'].includes(elite.attr));
  }
});
