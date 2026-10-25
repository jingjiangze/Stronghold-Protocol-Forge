// test/match/pack-msg-hosted.test.js — pack.msg (docs/MOD-SURFACE.md) reaches a match that runs in a match host
// (DESIGN §32.6).
// The lobby asks the match first (`Match.handlePackMsg`); for a hosted match that question travels over IPC, and the
// answer comes back as a boolean either way — the in-process Match and the MatchProxy must look the same to the caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchProxy, wireOptions } from '../../server/match/host/proxy.js';

/** A host double: `onPost` sees every message the proxy posts (and answers when it wants to). */
function fakeHost(onPost) {
  return { post: (m) => onPost(m) };
}

/**
 * The request timers are unref'd (a stray one must never hold the server open), so a test that waits for one has to
 * keep the event loop alive itself — otherwise node reports the pending promise after the loop has emptied.
 */
async function awaiting(promise) {
  const keep = setInterval(() => {}, 10);
  try { return await promise; } finally { clearInterval(keep); }
}

test('wireOptions carries the room\'s plugin ids (the gate a matchClass wrapper needs in a worker)', () => {
  const base = { roomCode: 'ABCD', mode: 'coop', difficulty: 'NORMAL', seats: [], seed: 1 };
  assert.equal('plugins' in wireOptions(base), false, 'a vanilla payload keeps its shape');
  const modded = { ...base, cs: '0123456789abcdef', requireCs: true, plugins: ['hexmod', 'room-chat'] };
  assert.deepEqual(wireOptions(modded).plugins, ['hexmod', 'room-chat']);
  assert.equal('plugins' in wireOptions({ ...base, plugins: [] }), true, 'an explicit empty list still rides');
});

test('MatchProxy.handlePackMsg: consumed rides the reply, and every other answer reads as "not consumed"', async () => {
  const replies = [];
  let proxy;
  const host = fakeHost((m) => {
    if (m.type !== 'call') return;
    replies.push(m.method);
    const result = m.method === 'handlePackMsg' ? { ok: true, consumed: m.args[1].consumed } : { ok: true };
    setImmediate(() => proxy.deliver({ type: 'reply', matchId: m.matchId, id: m.id, result }));
  });
  proxy = new MatchProxy({ host, matchId: 'm1', opts: { roomCode: 'ABCD' } });

  assert.equal(await proxy.handlePackMsg('p1', { consumed: true }), true, 'consumed');
  assert.equal(await proxy.handlePackMsg('p1', { consumed: false }), false, 'not consumed');
  assert.deepEqual(replies, ['handlePackMsg', 'handlePackMsg'], 'both went over IPC as handlePackMsg');

  // A match whose wrapper has no handler (entry.js answers consumed:false) still reads as "not consumed".
  proxy.deliver({ type: 'reply', matchId: 'm1', id: 999, result: { ok: true, consumed: false } });
  const silent = new MatchProxy({ host: fakeHost(() => {}), matchId: 'm2', opts: { roomCode: 'EFGH' }, requestTimeoutMs: 5 });
  assert.equal(await awaiting(silent.handlePackMsg('p1', {})), false, 'no answer → false (never throws)');
});

test('MatchProxy.handlePackMsg: a disposed match answers false instead of hanging', async () => {
  const proxy = new MatchProxy({ host: fakeHost(() => {}), matchId: 'm3', opts: { roomCode: 'IJKL' }, requestTimeoutMs: 5 });
  proxy.dispose();
  assert.equal(await proxy.handlePackMsg('p1', {}), false);
});
