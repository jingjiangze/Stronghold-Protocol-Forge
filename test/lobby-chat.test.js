// test/lobby-chat.test.js — room.chat (server/lobby.js sayInRoom): one line to the whole room, trimmed and cut by the
// server, one line a second per session, refused outside a room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../shared/constants.js';
import { Lobby, Room } from '../server/lobby.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A lobby with one coop room, a player in seat 0 and a spectator. `clock.ms` moves the clock. */
function setup() {
  const clock = { ms: 1_000_000 };
  const lobby = new Lobby({ registry: null, log: quiet, getData: () => ({ modes: {} }), options: {}, now: () => clock.ms });
  const room = new Room('CH12', 'coop', 'NORMAL', clock.ms);
  room.seats[0] = { seat: 0, playerId: 'p1', name: 'P1', isBot: false, connected: true, ready: false, left: false };
  room.seats[1] = { seat: 1, playerId: 'p2', name: 'P2', isBot: false, connected: true, ready: false, left: false };
  room.spectators = [{ playerId: 's1', name: 'S1', connected: true }];
  room.hostId = 'p1';
  lobby.rooms.set('CH12', room);
  const sent = [];
  lobby.broadcastRoom = (_room, msg) => { sent.push(msg); return null; };
  return { lobby, room, clock, sent };
}

test('a chat line reaches the room, trimmed and cut to 80 characters with control characters stripped', () => {
  const { lobby, clock, sent } = setup();
  const session = { playerId: 'p1', roomCode: 'CH12', name: 'P1' };
  assert.equal(lobby.sayInRoom(session, { text: '  你好\u0007，队友 \n ' }).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'room.chat');
  assert.equal(sent[0].text, '你好，队友');
  assert.equal(sent[0].name, 'P1');
  assert.equal(sent[0].seat, 0);
  assert.equal(sent[0].spectator, false);
  assert.equal(sent[0].playerId, 'p1');

  clock.ms += 1000;
  lobby.sayInRoom(session, { text: 'x'.repeat(200) });
  assert.equal(sent.at(-1).text.length, 80, 'cut to 80 characters');
});

test('an empty line is refused and does not count as a send', () => {
  const { lobby, clock, sent } = setup();
  const session = { playerId: 'p1', roomCode: 'CH12', name: 'P1' };
  assert.equal(lobby.sayInRoom(session, { text: '   ' }).error, ERR.BAD_MSG);
  assert.equal(lobby.sayInRoom(session, { text: '\u0001\u0002' }).error, ERR.BAD_MSG);
  assert.equal(sent.length, 0);
  clock.ms += 1000;
  assert.equal(lobby.sayInRoom(session, { text: 'hi' }).ok, true, 'a refused line does not use up the second');
});

test('one line a second per session; another session is unaffected', () => {
  const { lobby, clock, sent } = setup();
  const a = { playerId: 'p1', roomCode: 'CH12', name: 'P1' };
  const b = { playerId: 'p2', roomCode: 'CH12', name: 'P2' };
  assert.equal(lobby.sayInRoom(a, { text: 'one' }).ok, true);
  assert.equal(lobby.sayInRoom(a, { text: 'two' }).error, ERR.RATE);
  assert.equal(lobby.sayInRoom(b, { text: 'hi from b' }).ok, true, 'the limit is per session');
  clock.ms += 999;
  assert.equal(lobby.sayInRoom(a, { text: 'three' }).error, ERR.RATE);
  clock.ms += 1;
  assert.equal(lobby.sayInRoom(a, { text: 'three' }).ok, true);
  assert.deepEqual(sent.map((m) => m.text), ['one', 'hi from b', 'three']);
});

test('a spectator speaks with the spectator flag and no seat', () => {
  const { lobby, sent } = setup();
  const s = { playerId: 's1', roomCode: 'CH12', name: 'S1' };
  assert.equal(lobby.sayInRoom(s, { text: '观战视角' }).ok, true);
  assert.equal(sent[0].spectator, true);
  assert.equal(sent[0].seat, null);
});

test('outside a room there is nobody to talk to', () => {
  const { lobby } = setup();
  assert.equal(lobby.sayInRoom({ playerId: 'p1', roomCode: null, name: 'P1' }, { text: 'hi' }).error, ERR.NOT_IN_ROOM);
  assert.equal(lobby.sayInRoom({ playerId: 'zz', roomCode: 'CH12', name: 'ZZ' }, { text: 'hi' }).error, ERR.NOT_IN_ROOM);
});
