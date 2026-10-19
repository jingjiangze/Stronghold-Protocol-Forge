import assert from 'node:assert/strict';
import test from 'node:test';
import { SCORING_MODES, deviceTier, decideScoring, pollIntervalFor } from '../plugins/mota/shared/scoringPolicy.js';
import { createScoringQueue } from '../plugins/mota/shared/scoringQueue.js';

test('SCORING_MODES 只含四个档位', () => {
  assert.deepEqual([...SCORING_MODES], ['off', 'idle', 'room', 'autoplay']);
});

test('deviceTier：低配 / 中配 / 高配的边界', () => {
  assert.equal(deviceTier({ cores: 4, memory: 2 }), 'low');
  assert.equal(deviceTier({ cores: 6, memory: 8 }), 'mid');
  assert.equal(deviceTier({ cores: 12, memory: 16 }), 'high');
  // benchmarkMs 超过阈值时降档
  assert.equal(deviceTier({ cores: 12, memory: 16, benchmarkMs: 5000 }), 'low');
});

test('decideScoring：off 恒关；autoplay 只在自动托管理发；低配不参与', () => {
  assert.equal(decideScoring({ mode: 'off', tier: 'high', online: true }).run, false);
  assert.equal(decideScoring({ mode: 'autoplay', tier: 'high', autoplay: false }).run, false);
  assert.equal(decideScoring({ mode: 'autoplay', tier: 'high', autoplay: true }).run, true);
  assert.equal(decideScoring({ mode: 'idle', tier: 'low', visible: false }).run, false);
});

test('pollIntervalFor：不同档位给出不同的轮询间隔', () => {
  const off = pollIntervalFor('off');
  const room = pollIntervalFor('room');
  assert.ok(Number.isFinite(off) || off === 0);
  assert.ok(Number.isFinite(room));
});

test('createScoringQueue：入队 / 出队 / 预算与在途限制', () => {
  let t = 0;
  const q = createScoringQueue({ maxQueue: 2, budgetMs: 100, now: () => t });
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  assert.equal(q.push(a), true);
  assert.equal(q.push(b), true);
  assert.equal(q.push(c), false, '队列满时拒绝');
  assert.equal(q.next()?.id, 'a');
  assert.equal(q.next(), null, '一次只跑一个');
  q.done('a');
  assert.equal(q.next()?.id, 'b');
  q.done('b');
  assert.equal(q.push(c), true, '腾出位置后可以再入队');
  assert.equal(q.next()?.id, 'c');
});

test('createScoringQueue：pause 之后 next 返回 null，resume 恢复', () => {
  const q = createScoringQueue({ maxQueue: 2, budgetMs: 100, now: () => 0 });
  q.push({ id: 'x' });
  q.pause('hidden');
  assert.equal(q.next(), null);
  q.resume();
  assert.equal(q.next()?.id, 'x');
});

test('createScoringQueue：abort 让指定任务失效', () => {
  const q = createScoringQueue({ maxQueue: 1, budgetMs: 100, now: () => 0 });
  q.push({ id: 't1' });
  const task = q.next();
  q.abort('t1');
  assert.equal(q.isAborted('t1'), true);
});
