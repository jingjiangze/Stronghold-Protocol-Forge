import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch } from './harness.js';

/** A 2V2 match with four humans; bands are assigned by hand so initTeamHp can run without a full draft. */
function versusMatch() {
  const h = makeMatch({ mode: 'versus', difficulty: 'NORMAL', humans: 4, bots: 0, seed: 7, fake: true });
  const m = h.m;
  const band = Object.keys(DATA.bands)[0];
  for (const ps of m.order) ps.bandId = band;
  return { h, m, band };
}

test('versus: teams follow the seat index (0,0,1,1)', () => {
  const { m } = versusMatch();
  assert.equal(m.isVersus, true);
  assert.deepEqual(m.order.map((ps) => m.teamIdOf(ps)), [0, 0, 1, 1]);
  assert.deepEqual(m.matchTeamIds(), [0, 1]);
});

test('versus: initTeamHp builds one shared pool per team (sum of member startLp)', () => {
  const { m, band } = versusMatch();
  m.initTeamHp();
  assert.equal(m.teamLps.size, 2);
  const startLp = m.gd.startLp(band);
  assert.deepEqual([...m.teamLps.values()], [startLp * 2, startLp * 2]);
  assert.equal(m.teamLp, startLp * 4);
  // members' own lp is a split of the pool
  assert.equal(m.order.reduce((s, ps) => s + ps.lp, 0), startLp * 4);
});

test('versus: _versusTeamLpLoss drains one team only, never below 0', () => {
  const { m } = versusMatch();
  m.initTeamHp();
  const before1 = m.teamHpPool(1);
  const after0 = m._versusTeamLpLoss(0, 3);
  assert.equal(m.teamHpPool(0), after0);
  assert.equal(after0, m.teamHpPool(0));
  assert.equal(m.teamHpPool(1), before1, 'the other team is untouched');
  m._versusTeamLpLoss(0, 9999);
  assert.equal(m.teamHpPool(0), 0);
});

test('versus: before R14 the opponent rows are a stub; at R14 they are open', () => {
  const { m } = versusMatch();
  m.round = 5;
  m.phase = 'PREP';
  m.initTeamHp();
  const mine = m.publicView(0);
  const other = mine.players.filter((r) => r.seat >= 2);
  assert.ok(other.length === 2, 'two opponent rows');
  for (const row of other) {
    assert.equal(row.hidden, true, 'opponent row is hidden');
    assert.equal(row.fieldId, undefined, 'no field id');
    assert.equal(row.bonds, undefined, 'no bond strip');
  }
  assert.equal(mine.players[0].hidden, undefined, 'own row is untouched');
  m.round = 14;
  const revealed = m.publicView(0);
  assert.ok(revealed.players.every((r) => r.hidden !== true), 'R14 reveals both sides');
});

test('solo/coop: no team shape in the public view', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 7, fake: true });
  assert.equal(h.m.isVersus, false);
  assert.equal(h.m.teamLps, null);
  assert.equal('teamLps' in h.m.publicView(), false);
});
