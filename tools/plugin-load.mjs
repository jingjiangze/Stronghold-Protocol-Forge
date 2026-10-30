#!/usr/bin/env node
// tools/plugin-load.mjs —— 插件「真装载」门：把 `npm test` 里顺带跑到的两个文件单独跑一遍，
// 并且**先验判据本身还在**。
//
// 为什么单独成门：`test/plugins/registry.test.js` 与 `test/match/plugin-host.test.js` 红在
// 4 个矩阵里的某一条时，和「某个单测挂了」看上去没区别 —— 而它们回答的是**另一个问题**：
// 插件到底装不装得上、对局宿主跑起来有没有引擎错误（`errorCount === 0`）。
//
// 三道自检（判据失效必须报红，不能静默绿）：
//   ① 两个测试文件在不在
//   ② `plugin-host.test.js` 里的 `errorCount` 断言有没有被删
//   ③ `registry.test.js` 还是不是用 `pluginsDir` 起 server
//
//   node tools/plugin-load.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = ['test/plugins/registry.test.js', 'test/match/plugin-host.test.js'];

const fail = (msg) => { console.error(`::error::${msg}`); process.exitCode = 1; };

// ── ① 文件在不在 ──
for (const f of TESTS) {
  if (!fs.existsSync(path.join(ROOT, f))) fail(`${f} 不见了 —— 真装载门失去判据（这不是绿，是判据失效）`);
}

// ── ②③ 判据本身还在不在 ──
const hostTest = path.join(ROOT, 'test/match/plugin-host.test.js');
if (fs.existsSync(hostTest) && !fs.readFileSync(hostTest, 'utf8').includes('errorCount')) {
  fail('test/match/plugin-host.test.js 里的 errorCount 断言没了 —— 「装载无错」的判据被删');
}
const regTest = path.join(ROOT, 'test/plugins/registry.test.js');
if (fs.existsSync(regTest) && !fs.readFileSync(regTest, 'utf8').includes('pluginsDir')) {
  fail('test/plugins/registry.test.js 不再用 pluginsDir 起 server —— 判据被改');
}
if (process.exitCode) process.exit(process.exitCode);

// ── 逐个跑（同端口/同夹具不并发，避免互踩） ──
let bad = 0;
for (const f of TESTS) {
  console.log(`\n── ${f} ${'─'.repeat(Math.max(0, 60 - f.length))}`);
  const r = spawnSync(process.execPath, ['--test', f], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const line = (k) => (out.match(new RegExp(`^# ${k} \\d+`, 'm')) || [''])[0];
  console.log([line('tests'), line('pass'), line('fail')].filter(Boolean).join(' · ') || '（没有读到计数行）');
  const n = Number((out.match(/^# tests (\d+)/m) || [])[1] || 0);
  if (n < 1) { console.error(`::error::${f} 一条用例都没跑 —— 判据失效，不报绿`); bad += 1; }
  if (r.status !== 0) {
    console.error(`::error::${f} 红（rc=${r.status}）`);
    console.log(out);
    bad += 1;
  }
}
if (bad) process.exit(1);
console.log('\n插件真装载门：通过');
