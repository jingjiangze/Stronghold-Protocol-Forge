import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/lobby.js';
import { validateC2S } from '../shared/protocol.js';
import { TEAMS, teamOfSeat } from '../shared/constants.js';

const seat = (i, id, ready = false) => ({ seat: i, playerId: id, name: id, isBot: false, ready, connected: true, left: false });

test('versus room: room.state names each seat\'s team and the team count', () => {
  const vs = new Room('abcd', 'versus', 'NORMAL', 0);
  vs.seats = [seat(0, 'p1'), seat(1, 'p2'), seat(2, 'p3'), seat(3, 'p4')];
  const state = vs.toState();
  assert.equal(state.teams, TEAMS);
  assert.deepEqual(state.seats.map((s) => s.team), [0, 0, 1, 1]);
});

test('coop room: room.state carries no team shape', () => {
  const co = new Room('abcd', 'coop', 'NORMAL', 0);
  co.seats = [seat(0, 'p1'), seat(1, 'p2'), null, null];
  const state = co.toState();
  assert.equal(state.teams, undefined);
  assert.equal(state.seats[0].team, undefined);
});

test('room.create accepts versus and rejects an unknown mode', () => {
  assert.equal(validateC2S({ t: 'room.create', mode: 'versus', difficulty: 'NORMAL', private: false }), null);
  assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', private: false }), null);
  assert.match(String(validateC2S({ t: 'room.create', mode: '2v2', difficulty: 'NORMAL', private: false })), /mode/);
});

test('room.swapSeats validates two in-range seats', () => {
  assert.equal(validateC2S({ t: 'room.swapSeats', a: 0, b: 2 }), null);
  assert.match(String(validateC2S({ t: 'room.swapSeats', a: 0, b: 99 })), /b/);
  assert.match(String(validateC2S({ t: 'room.swapSeats', a: 0 })), /b/);
});

test('teamOfSeat matches the room state mapping used by versus', () => {
  assert.deepEqual([0, 1, 2, 3].map((s) => teamOfSeat(s)), [0, 0, 1, 1]);
});
