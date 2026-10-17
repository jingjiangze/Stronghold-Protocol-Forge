// test/forgeAdapters.test.js — 适配器注册表 + 服务端载荷的房间门控。
//
// 两条不变量是这一阶段的核心（各一条测试）：
//   1. **未选中 ⇒ 绝不调用**：一个没被这一局选中的包，它的服务端载荷一次都不许被调用；
//   2. **未开脚本 ⇒ 不执行且点名**：`SP_PLUGIN_SCRIPTS` 没开时不做，且必须出现在 `skipped` 里（不许静默吞）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTERS, adaptersFor, enabledAdapters, planPack, planPayloads, applyPayloads,
} from '../server/forge/adapters/index.js';
import { planUiFrames } from '../server/forge/frames.js';

const quiet = { warn() {} };

function pack(extra = {}) {
  return {
    id: 'demo',
    manifest: { content: ['chess'], ...extra },
    content: { documents: { 'chess.json': { records: 1, entries: [] } } },
    files: [{ path: 'chess.json' }],
  };
}

test('注册表：四格、顺序固定、各有 status', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.id), ['content', 'ui', 'cosmetic', 'payloads']);
  for (const a of ADAPTERS) assert.ok(['done', 'planned'].includes(a.status), `${a.id} 必须有 status`);
  assert.equal(ADAPTERS.find((a) => a.id === 'cosmetic').status, 'planned', '资源容器本版明确未接线');
});

test('enabledAdapters：缺省全开；具名只开那几格；未知名字被点名', () => {
  assert.deepEqual(enabledAdapters({}, { log: quiet }), ['content', 'ui', 'cosmetic', 'payloads']);
  assert.deepEqual(enabledAdapters({ SP_FORGE_ADAPTERS: 'content,ui' }, { log: quiet }), ['content', 'ui']);
  const warned = [];
  const got = enabledAdapters({ SP_FORGE_ADAPTERS: 'content,bogus' }, { log: { warn: (m) => warned.push(m) } });
  assert.deepEqual(got, ['content']);
  assert.match(warned[0], /bogus/);
});

test('adaptersFor：只命中包真的声明了的那几格', () => {
  const plain = pack();
  assert.deepEqual(adaptersFor(plain).map((a) => a.id), ['content']);
  const withUi = pack({ client: { panels: [{ id: 'p', slot: 'root.guide', module: 'ui/p.js' }] } });
  withUi.files = [{ path: 'ui/p.js' }];
  assert.deepEqual(adaptersFor(withUi).map((a) => a.id), ['content', 'ui']);
  const withPayload = pack({ server: { battle: { module: 'b.mjs' } } });
  assert.ok(adaptersFor(withPayload).some((a) => a.id === 'payloads'));
});

test('planPack：planned 的适配器必须留下"未接线"的说明（不伪装成跑起来）', () => {
  const withAssets = pack({ assets: { container: 'a.spresources', manifest: 'a.json' } });
  withAssets.files = [{ path: 'a.spresources' }, { path: 'a.json' }];
  const plan = planPack(withAssets);
  const cosmetic = plan.adapters.find((a) => a.id === 'cosmetic');
  assert.equal(cosmetic.status, 'planned');
  assert.ok(plan.notes.some((n) => /cosmetic.*未接线/.test(n)), '未接线要写进 notes');
  assert.equal(cosmetic.result.containers[0].file, 'a.spresources');
});

test('planPack 的 ui 适配器接到转译器上（27 个 frame 那条链）', () => {
  const p = pack({ client: { panels: [{ id: 'hud', slot: 'screen.game.hud', module: 'ui/hud.js' }] } });
  p.files = [{ path: 'ui/hud.js' }];
  const plan = planPack(p, { planFrames: (x) => planUiFrames(x) });
  const ui = plan.adapters.find((a) => a.id === 'ui');
  assert.equal(ui.result.frames.length, 1);
  assert.equal(ui.result.frames[0].slot, 'hud.right');
});

// ---- 不变量 1：未选中 ⇒ 绝不调用 ---------------------------------------------------------------
test('不变量①：房间没选中的包，服务端载荷一次都不会被调用', () => {
  const plans = new Map([
    ['a', planPayloads({ id: 'a', manifest: { server: { battle: { module: 'A.mjs' } } } }, { scriptsEnabled: true })],
    ['b', planPayloads({ id: 'b', manifest: { server: { modules: [{ id: 'm', entry: 'B.mjs' }] } } }, { scriptsEnabled: true })],
  ]);
  const called = [];
  const r = applyPayloads({ selected: ['a'], plans, invoke: (e) => called.push(e.pack) });
  assert.deepEqual(called, ['a'], '只调用了被选中的 a');
  assert.deepEqual(r.notSelected, ['b'], '没被选中的包要被点名，而不是静默跳过');
  assert.deepEqual(r.invoked.map((e) => e.pack), ['a']);
});

// ---- 不变量 2：未开脚本 ⇒ 不执行且点名 ---------------------------------------------------------
test('不变量②：SP_PLUGIN_SCRIPTS 未开 ⇒ 不产出可执行条目，且逐格进 skipped', () => {
  const p = { id: 'x', manifest: { server: { battle: { module: 'X.mjs' }, meta: [{ id: 'm' }] } } };
  const off = planPayloads(p, { scriptsEnabled: false });
  assert.deepEqual(off.entries, [], '没开脚本就不该有条目');
  assert.equal(off.skipped.length, 2, '每一格都要点名');
  assert.ok(off.skipped.every((s) => /SP_PLUGIN_SCRIPTS/.test(s.reason)));

  const on = planPayloads(p, { scriptsEnabled: true });
  assert.equal(on.entries.length, 2);
  assert.deepEqual(on.skipped, []);
});

test('applyPayloads 把 skipped 原样传出来（调用方看得见"为什么没跑"）', () => {
  const plans = new Map([['x', planPayloads({ id: 'x', manifest: { server: { battle: { module: 'X.mjs' } } } }, { scriptsEnabled: false })]]);
  const r = applyPayloads({ selected: ['x'], plans, invoke: () => assert.fail('不该被调用') });
  assert.deepEqual(r.invoked, []);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].pack, 'x');
});

test('载荷抛异常只记一条，不影响同包其它载荷与其它包', () => {
  const plans = new Map([
    ['a', planPayloads({ id: 'a', manifest: { server: { battle: { module: 'A.mjs' }, room: { module: 'R.mjs' } } } }, { scriptsEnabled: true })],
    ['b', planPayloads({ id: 'b', manifest: { server: { battle: { module: 'B.mjs' } } } }, { scriptsEnabled: true })],
  ]);
  const called = [];
  const r = applyPayloads({
    selected: ['a', 'b'], plans,
    invoke: (e) => { called.push(e.kind); if (e.kind === 'battle' && e.pack === 'a') throw new Error('boom'); },
  });
  assert.equal(called.length, 3, '三个载荷都被试过');
  assert.equal(r.invoked.length, 2);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /boom/);
});
