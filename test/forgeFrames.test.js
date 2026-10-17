// test/forgeFrames.test.js — Forge 面板 → 0.3.0 ui frame 的转译器。
//
// 钉住四件事（缺一条 frame 在 0.3.0 里就是"装了但什么都不显示"）：
//   1. frame 与面板模块**同目录**（0.3.0 只允许 frame 引用同目录文件）；
//   2. frame 里有 welcome ⇒ ready 的握手（不握手宿主不投递数据帧）；
//   3. frame 用**相对路径** import 原模块，并调 mount(ctx)，ctx.host 是容器；
//   4. 槽位映射必须显式：没有对应物的落到 room.panel，并且**点名写进 notes**（不静默丢位置）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { frameHtml, framePathFor, mapSlot, planUiFrames, SP_UI_SLOTS } from '../server/forge/frames.js';

test('framePathFor：与模块同目录、换扩展名', () => {
  assert.equal(framePathFor('ui/panel.js'), 'ui/panel.frame.html');
  assert.equal(framePathFor('hud.js'), 'hud.frame.html');
  assert.equal(framePathFor('a/b/c.mjs'), 'a/b/c.frame.html');
  assert.equal(framePathFor('a\\b\\c.js'), 'a/b/c.frame.html', 'Windows 分隔符先归一化');
});

test('槽位映射：语义接近的才 exact，其余显式回落到 room.panel', () => {
  assert.deepEqual(mapSlot('screen.game.hud'), { slot: 'hud.right', exact: true, from: 'screen.game.hud' });
  assert.deepEqual(mapSlot('screen.result.footer'), { slot: 'result.tab', exact: true, from: 'screen.result.footer' });
  const overlay = mapSlot('root.overlays');
  assert.equal(overlay.slot, 'room.panel');
  assert.equal(overlay.exact, false);
  assert.equal(mapSlot('不存在的槽位').slot, 'room.panel', '未知槽位也有去处（且 exact=false）');
  // 映射目标必须都在 0.3.0 的闭集里
  for (const s of ['screen.game.hud', 'screen.result.footer', 'root.overlays', 'screen.game.shopCard']) {
    assert.ok(SP_UI_SLOTS.includes(mapSlot(s).slot), `${s} 映射到合法槽位`);
  }
});

test('frame 内容：握手 + 相对 import + mount(ctx) + 容器', () => {
  const html = frameHtml({ moduleRel: 'ui/panel.js', title: '<x>', styles: ['ui/panel.css'] });
  assert.match(html, /parent\.postMessage\(\{\s*v:\s*1,\s*t:\s*'ready'\s*\}/, 'welcome ⇒ ready 握手');
  assert.match(html, /import\('\.\/panel\.js'\)/, '相对路径 import 原模块（同目录）');
  assert.match(html, /typeof mod\.mount === 'function' \? mod\.mount :/, 'mount(ctx) 或 default 导出都接受');
  assert.match(html, /const host = document\.getElementById\('sp-host'\)/, 'ctx.host 是一个容器');
  assert.match(html, /host,\s*\n\s*log,/, 'ctx 带 host 与 log');
  assert.match(html, /panel\.css/, 'styles 以同目录相对路径引用');
  assert.match(html, /&lt;x&gt;/, '标题做 HTML 转义');
});

test('planUiFrames：逐面板出 frame，缺模块/不在包里都点名', () => {
  const pack = {
    id: 'demo', manifest: { name: 'Demo', client: { panels: [
      { id: 'hud', slot: 'screen.game.hud', module: 'ui/hud.js', title: 'HUD' },
      { id: 'guide', slot: 'root.guide', module: 'ui/guide.js' },
      { id: 'ghost', slot: 'root.overlays', module: 'ui/ghost.js' },   // 不在包里
      { id: 'nomod', slot: 'root.overlays' },                          // 没 module
    ] } },
    files: [{ path: 'ui/hud.js' }, { path: 'ui/guide.js' }],
  };
  const { frames, notes } = planUiFrames(pack);
  assert.equal(frames.length, 2, '只有两个真面板');
  assert.equal(frames[0].frame, 'ui/hud.frame.html');
  assert.equal(frames[0].slot, 'hud.right');
  assert.equal(frames[0].exact, true);
  assert.equal(frames[1].slot, 'room.panel');
  assert.equal(frames[1].exact, false);
  assert.ok(notes.some((n) => /root\.guide.*room\.panel/.test(n)), '槽位替换必须点名');
  assert.ok(notes.some((n) => /ghost\.js/.test(n)), '模块不在包里要点名');
  assert.ok(notes.some((n) => /没有 module/.test(n)), '缺 module 要点名');
});

test('没有面板的包 ⇒ 空计划，不抛', () => {
  assert.deepEqual(planUiFrames({ manifest: {} }).frames, []);
  assert.deepEqual(planUiFrames({}).frames, []);
});
