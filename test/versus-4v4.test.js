// test/versus-4v4.test.js — a versus room's team size decides its seat capacity: 2 → 4 seats (2V2, the default),
// 4 → 8 seats (4V4). One binary, one code path: the room's `teamSize` flows into room.state, the lobby's Match opts,
// PlayerState.team and the per-team HP pools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/lobby.js';
import { validateC2S } from '../shared/protocol.js';
import { MAX_SEATS, MAX_SEATS_VERSUS, TEAMS, teamOfSeat } from '../shared/constants.js';
import { DATA, makeMatch } from './match/harness.js';

const seat = (i, id) => ({ seat: i, playerId: id, name: id, isBot: false, ready: false, connected: true, left: false });
const eight = (room) => {
  room.seats = Array.from({ length: 8 }, (_, i) => seat(i, `p${i + 1}`));
  return room;
};

test('4v4: a versus room created with teamSize 4 has 8 seats, 2 keeps 4', () => {
  const four = new Room('abcd', 'versus', 'NORMAL', 0, 4);
  assert.equal(four.teamSize, 4);
  assert.equal(four.seats.length, MAX_SEATS_VERSUS);
  assert.equal(four.seats.length, 8);

  const two = new Room('abcd', 'versus', 'NORMAL', 0);
  assert.equal(two.teamSize, 2, 'the default is 2V2');
  assert.equal(two.seats.length, 4);

  // co-op / solo ignore the option entirely
  assert.equal(new Room('abcd', 'coop', 'NORMAL', 0, 4).seats.length, MAX_SEATS);
  assert.equal(new Room('abcd', 'coop', 'NORMAL', 0, 4).teamSize, 1);
  assert.equal(new Room('abcd', 'solo', 'NORMAL', 0, 4).seats.length, MAX_SEATS);
});

test('4v4: room.state carries teamSize and splits the 8 seats into 2 teams of 4', () => {
  const room = eight(new Room('abcd', 'versus', 'NORMAL', 0, 4));
  const state = room.toState();
  assert.equal(state.teams, TEAMS);
  assert.equal(state.teamSize, 4);
  assert.deepEqual(state.seats.map((s) => s.team), [0, 0, 0, 0, 1, 1, 1, 1]);
  // 2V2 keeps its exact old shape
  const two = new Room('abcd', 'versus', 'NORMAL', 0);
  two.seats = [seat(0, 'a'), seat(1, 'b'), seat(2, 'c'), seat(3, 'd')];
  assert.deepEqual(two.toState().seats.map((s) => s.team), [0, 0, 1, 1]);
  assert.equal(two.toState().teamSize, 2);
});

test('4v4: teamOfSeat takes an options object (a plain .map call keeps the 2V2 default)', () => {
  assert.deepEqual([0, 1, 2, 3].map(teamOfSeat), [0, 0, 1, 1], 'map passes the index — must not become a team size');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((s) => teamOfSeat(s, { teamSize: 4 })), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.equal(teamOfSeat(7, { teamSize: 2 }), 1);
  assert.equal(teamOfSeat(4, null), 0, 'no options = 2V2');
});

test('4v4: protocol accepts teamSize 2 / 4 and refuses anything else', () => {
  const msg = (teamSize) => ({ t: 'room.create', mode: 'versus', difficulty: 'NORMAL', private: false, teamSize });
  assert.equal(validateC2S(msg(2)), null);
  assert.equal(validateC2S(msg(4)), null);
  assert.match(String(validateC2S(msg(3))), /teamSize/);
  assert.match(String(validateC2S(msg(8))), /teamSize/);
  // omitted = the 2V2 default; the seat bounds allow the 4V4 range
  assert.equal(validateC2S({ t: 'room.create', mode: 'versus', difficulty: 'NORMAL', private: false }), null);
  assert.equal(validateC2S({ t: 'room.swapSeats', a: 0, b: 7 }), null);
  assert.match(String(validateC2S({ t: 'room.swapSeats', a: 0, b: 8 })), /b/);
});

test('4v4: an eight-seat match builds two shared HP pools of four', () => {
  const h = makeMatch({ mode: 'versus', difficulty: 'NORMAL', humans: 8, bots: 0, seed: 7, fake: true, teamSize: 4 });
  const m = h.m;
  assert.equal(m.teamSize, 4);
  assert.deepEqual(m.order.map((ps) => m.teamIdOf(ps)), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(m.matchTeamIds(), [0, 1]);
  const band = Object.keys(DATA.bands)[0];
  for (const ps of m.order) ps.bandId = band;
  m.initTeamHp();
  const startLp = m.gd.startLp(band);
  assert.equal(m.teamLps.size, 2);
  assert.deepEqual([...m.teamLps.values()], [startLp * 4, startLp * 4]);
  assert.equal(m.order.reduce((s, ps) => s + ps.lp, 0), startLp * 8, 'each member holds a split of the pool');

  // the public view lists all eight rows, in seats, each with its team
  m.round = 5;
  m.phase = 'PREP';
  const pv = m.publicView(0);
  assert.equal(pv.players.length, 8);
  assert.deepEqual(pv.players.map((r) => r.team), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.equal(pv.players.filter((r) => r.hidden === true).length, 4, 'the four opponents are stubs before R14');
});

test('4v4: the 2V2 default is unchanged when no teamSize is given', () => {
  const h = makeMatch({ mode: 'versus', difficulty: 'NORMAL', humans: 4, bots: 0, seed: 7, fake: true });
  assert.equal(h.m.teamSize, 2);
  assert.deepEqual(h.m.order.map((ps) => h.m.teamIdOf(ps)), [0, 0, 1, 1]);
  // a co-op match has no teams at all
  const coop = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 7, fake: true }).m;
  assert.equal(coop.teamSize, 1);
  assert.deepEqual(coop.order.map((ps) => ps.team), [0, 0]);
});

test('4v4: the event period offers all four opponents (oppC / oppD join the 2V2 pair)', () => {
  const ready = (teamSize, humans) => {
    const h = makeMatch({ mode: 'versus', difficulty: 'NORMAL', humans, bots: 0, seed: 7, fake: true, teamSize });
    const m = h.m;
    const band = Object.keys(DATA.bands)[0];
    for (const ps of m.order) ps.bandId = band;
    m.initTeamHp();
    m.round = m.eventRounds[0];
    m.phase = 'ROUND_START';
    m.enterEvent();
    return m;
  };
  const four = ready(4, 8);
  const p0 = four.players.get('p_0');
  assert.deepEqual(four.eventTargetKeys(), ['self', 'mate', 'oppA', 'oppB', 'oppC', 'oppD']);
  assert.deepEqual(four.eventAvailableTargets(p0), ['self', 'mate', 'oppA', 'oppB', 'oppC', 'oppD']);
  assert.equal(four.eventTargetMap(p0).oppC.playerId, 'p_6');
  assert.equal(four.eventTargetMap(p0).oppD.playerId, 'p_7');
  // the panel gets the same six keys through m.public
  assert.deepEqual(Object.keys(four.publicView(0).event.ally.targets['p_0']), ['self', 'mate', 'oppA', 'oppB', 'oppC', 'oppD']);
  assert.equal(four.pickEvent(p0, 'oppD').ok, true, 'the fourth opponent is a legal target in 4V4');

  const two = ready(2, 4);
  const q0 = two.players.get('p_0');
  assert.deepEqual(two.eventTargetKeys(), ['self', 'mate', 'oppA', 'oppB'], '2V2 keeps the four keys');
  assert.equal(two.pickEvent(q0, 'oppC').error, 'BAD_TARGET', 'and refuses a key its room does not offer');
});
