import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_MODES, TEAM_SIZE, TEAMS, VERSUS_CONFRONT, opponentRevealed, teamOfSeat } from '../shared/constants.js';

test('versus constants: the room mode list and the 2V2 team sizes', () => {
  assert.deepEqual([...ROOM_MODES], ['solo', 'coop', 'versus']);
  assert.equal(TEAM_SIZE, 2);
  assert.equal(TEAMS, 2);
});

test('teamOfSeat: seats 0/1 are team 0, seats 2/3 are team 1', () => {
  assert.deepEqual([0, 1, 2, 3].map(teamOfSeat), [0, 0, 1, 1]);
});

test('opponentRevealed: R13 is still hidden, R14 is revealed', () => {
  assert.equal(opponentRevealed(13), false);
  assert.equal(opponentRevealed(14), true);
  assert.equal(opponentRevealed(undefined), false);
});

test('VERSUS_CONFRONT: the shared rhythm and the boss wire bound', () => {
  assert.equal(VERSUS_CONFRONT.ratioBase, 0.05);
  assert.equal(VERSUS_CONFRONT.ratioStep, 0.02);
  assert.equal(VERSUS_CONFRONT.ratioMax, 0.15);
  assert.equal(VERSUS_CONFRONT.huntRound, 13);
  assert.equal(VERSUS_CONFRONT.huntRatio, 0.5);
  assert.equal(VERSUS_CONFRONT.budgetMul, 2);
  assert.equal(VERSUS_CONFRONT.rosterMs, 5000);
  assert.equal(VERSUS_CONFRONT.maxPicks, 64);
  assert.equal(VERSUS_CONFRONT.maxBosses, 32);
  assert.deepEqual([...VERSUS_CONFRONT.positions], ['front', 'mid', 'back']);
});
