// test/modRoutes.test.js — 包声明的**只读 HTTP 路由**（`pack.json.routes`，DESIGN §28.13，docs/WORKSHOP.md §1.9；
// A 段只认下声明，B1 段把服务面落地）。
//
// 这一层的载重是「刻意窄」四个字，所以断言也只围绕窄：
//   * **命中**：只有**精确等于**声明路径的请求被回答，内容就是包内那个 `.json`，`Cache-Control` 按声明给；
//   * **未命中**：照旧走核心静态挂载（于是普通 404），不会因为「包声明过别的路径」而改变任何既有行为；
//   * **只读**：没有写路径（routes.js 早就把非 GET/HEAD 挡成 405）、不做目录列表、不做任何重写；
//   * **只 `.json`**：`.js` / `.html` 在服务面**再拒一次**（形状层拒过，但这一层读到的声明可能来自旧 schema 或
//     手工构造的装载结果 —— 代码执行面这条线不许只靠上游把关）；
//   * **路径越不出去**：声明里带 `..`、解析后逃出包目录、以及请求侧的编码穿越，全部拒绝，而且拒绝的方式是
//     「没有这个 key」/「403」，不是「拼出一条包外路径然后读它」。
//
// Run: node --test test/modRoutes.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { ROUTE_CACHE_POLICIES } from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';
import { workshopRoutesFor, ROUTE_CACHE_HEADERS, coreDataFiles, claimsCorePath } from '../server/http/workshop.js';
import { startServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let tmp;
let wsRoot;
let wsBad;

const MANIFEST = JSON.stringify({ version: 'v1', files: [{ url: '/a', sha256: 'a'.repeat(64) }] });
const NOSTORE = JSON.stringify({ n: 1 });
const PUBLIC = JSON.stringify({ p: 1 });

/** 三份包：一份声明三条路由（三种 cache），一份抢占一条**核心路径**，一份不带任何 content。 */
const PACKS = {
  'manifest-pack': {
    pack: {
      name: 'Manifest',
      routes: [
        { path: '/data/resource-manifest.json', file: 'resource-manifest.json', cache: 'no-cache' },
        { path: '/sp-nostore.json', file: 'n.json', cache: 'no-store' },
        { path: '/sp-public.json', file: 'p.json', cache: 'public' },
      ],
    },
    files: { 'resource-manifest.json': MANIFEST, 'n.json': NOSTORE, 'p.json': PUBLIC },
  },
  'core-claim': {
    pack: { name: 'CoreClaim', routes: [{ path: '/sp-own-namespace.json', file: 'support.json', cache: 'no-store' }] },
    files: { 'support.json': JSON.stringify({ from: 'the pack' }) },
  },
};

/**
 * 单独一棵 workshop 根：这份包试图声明**引擎自己的**路径（DESIGN §28.40）。
 * 它必须整包被拒，所以不能和上面那些好包混在同一棵树里（混在一起会让第一条用例的 `errors` 判据失去意义）。
 */
const RESERVED_PACKS = {
  'reserved-claim': {
    pack: { name: 'ReservedClaim', routes: [{ path: '/data/support.json', file: 'support.json', cache: 'public' }] },
    files: { 'support.json': JSON.stringify({ from: 'the pack' }) },
  },
};

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-modroutes-'));
  wsRoot = join(tmp, 'ws');
  wsBad = join(tmp, 'ws-reserved');
  const write = (root, packs) => {
    for (const [id, pack] of Object.entries(packs)) {
      const dir = join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id, version: '0.1.0', license: 'CC0-1.0', ...pack.pack }));
      for (const [rel, body] of Object.entries(pack.files)) fs.writeFileSync(join(dir, rel), body);
    }
  };
  write(wsRoot, PACKS);
  write(wsBad, RESERVED_PACKS);
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** 一个手工构造的装载结果（服务面必须自己判，不能假设形状层已经把坏的挡住了）。 */
const fakeLoaded = (routes, dir = wsRoot) => ({ packs: [{ id: 'hand', dir, routes }] });

// ---------------------------------------------------------------------------------------------------
// 1. 服务面自己的判据（workshopRoutesFor）
// ---------------------------------------------------------------------------------------------------
describe('routes: 服务面自己的判据（只读 / 只 .json / 越不出去）', () => {
  test('声明合法：绝对路径 → 包内文件，cache 缺省 no-cache，三种语义都有对应的 Cache-Control', () => {
    const { routes, errors } = workshopRoutesFor(loadWorkshop(wsRoot, { log: quiet }), wsRoot, { log: quiet });
    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.deepEqual([...routes.keys()].sort(), ['/data/resource-manifest.json', '/sp-nostore.json', '/sp-own-namespace.json', '/sp-public.json']);
    const m = routes.get('/data/resource-manifest.json');
    assert.equal(m.file, join(wsRoot, 'manifest-pack', 'resource-manifest.json'));
    assert.equal(m.cache, 'no-cache');
    assert.equal(m.pack, 'manifest-pack');
    assert.equal(routes.get('/sp-nostore.json').cache, 'no-store');
    assert.equal(routes.get('/sp-public.json').cache, 'public');
    // 三种语义就是三种，与 shared/workshop.js 那份闭枚举一一对应
    assert.deepEqual(Object.keys(ROUTE_CACHE_HEADERS).sort(), [...ROUTE_CACHE_POLICIES].sort());
    assert.deepEqual(ROUTE_CACHE_POLICIES, ['no-cache', 'no-store', 'public']);
    assert.equal(ROUTE_CACHE_HEADERS.public, 'public, max-age=86400');
  });

  test('`.js` / `.html` 在服务面再拒一次（不是「形状层拒过就算」）', () => {
    const cases = [
      [{ path: '/a.js', file: 'a.js' }, 'code'],
      [{ path: '/a.html', file: 'a.html' }, 'markup'],
      [{ path: '/a.json', file: 'sub/../a.js' }, 'traversal into code'],
    ];
    for (const [route, why] of cases) {
      const { routes, errors } = workshopRoutesFor(fakeLoaded([route]), wsRoot, { log: quiet });
      assert.equal(routes.size, 0, `${why}: 不得进路由表`);
      assert.equal(errors.length, 1);
      assert.match(errors[0].reason, /never serves code or markup|outside the pack/);
    }
  });

  test('路径越界：相对路径、`..`、包外解析一律拒绝', () => {
    const bad = [
      { path: 'data/a.json', file: 'a.json' },              // 不是绝对路径
      { path: '/../a.json', file: 'a.json' },               // path 里有 ..
      { path: '/a.json', file: '../a.json' },               // file 里有 ..
      { path: '/a.json', file: '/etc/a.json' },             // file 是绝对路径
      { path: '/a\\b.json', file: 'a.json' },               // 反斜杠
    ];
    for (const route of bad) {
      const { routes, errors } = workshopRoutesFor(fakeLoaded([route]), wsRoot, { log: quiet });
      assert.equal(routes.size, 0, JSON.stringify(route));
      assert.equal(errors.length, 1, JSON.stringify(route));
    }
    // 一个**能解析出包内相对路径**但逃出包目录的 file（`sub/../../x.json` 这类拼法已经在上面的 `..` 里被拒了，
    // 这里再钉一条控制：正常写法必须落回包内）
    const inside = workshopRoutesFor(fakeLoaded([{ path: '/ok.json', file: 'sub/ok.json' }]), wsRoot, { log: quiet });
    assert.equal(inside.routes.get('/ok.json').file, join(wsRoot, 'sub', 'ok.json'));
  });

  test('两个包声明同一条路径：包 id 小的赢，输的那条被报告（DESIGN §28.3）', () => {
    const loaded = { packs: [
      { id: 'zeta', dir: join(wsRoot, 'manifest-pack'), routes: [{ path: '/x.json', file: 'resource-manifest.json' }] },
      { id: 'alpha', dir: join(wsRoot, 'core-claim'), routes: [{ path: '/x.json', file: 'support.json' }] },
    ] };
    const { routes, errors } = workshopRoutesFor(loaded, wsRoot, { log: quiet });
    assert.equal(routes.get('/x.json').pack, 'alpha', '小 id 赢（与数据叠加 / kit 碰撞同一条规则）');
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /already declared by pack "alpha"/);
  });

  test('文件不在时路由**留在表里**（于是 404，而不是悄悄回落到同名核心文件）+ 一条报告', () => {
    // 这条「声明即占用」的几何原来用 `/data/chess.json` 当靶子；§28.40 起那条路径根本进不了表（保留命名空间），
    // 所以换一条包自己的路径来钉**没变的那一半**：声明过、文件没了 ⇒ 404，不回落。
    const { routes, errors } = workshopRoutesFor(fakeLoaded([{ path: '/sp-gone.json', file: 'gone.json' }]), wsRoot, { log: quiet });
    assert.ok(routes.has('/sp-gone.json'), '声明的路径必须在表里 —— 否则它会回落到别处那份同名内容');
    assert.equal(routes.get('/sp-gone.json').file, join(wsRoot, 'gone.json'));
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /declared in pack\.json but missing/);
  });

  test('没有包 / 关掉工坊（workshopDir null）时是空表', () => {
    assert.equal(workshopRoutesFor(null, wsRoot).routes.size, 0);
    assert.equal(workshopRoutesFor(loadWorkshop(wsRoot, { log: quiet }), null).routes.size, 0);
    assert.equal(workshopRoutesFor(loadWorkshop(wsRoot, { log: quiet }), '').routes.size, 0);
  });

  test('routes 不是数组的装载结果被忽略（不抛）', () => {
    const { routes, errors } = workshopRoutesFor({ packs: [{ id: 'x', dir: wsRoot, routes: 'nope' }] }, wsRoot, { log: quiet });
    assert.equal(routes.size, 0);
    assert.deepEqual(errors, []);
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 真 HTTP：命中 / 未命中 / cache 头 / 穿越 / 只读
// ---------------------------------------------------------------------------------------------------
describe('routes: 真 HTTP 服务面', () => {
  test('命中声明路径、Cache-Control 按声明、未命中照旧 404、穿越拿不到包外文件', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    const get = (p) => fetch(`${srv.url}${p}`);
    try {
      // 命中：no-cache（缺省）
      const m = await get('/data/resource-manifest.json');
      assert.equal(m.status, 200);
      assert.equal(m.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(m.headers.get('cache-control'), 'no-cache');
      assert.deepEqual(await m.json(), JSON.parse(MANIFEST));
      // 三种语义各一条
      const n = await get('/sp-nostore.json');
      assert.equal(n.status, 200);
      assert.equal(n.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await n.json(), JSON.parse(NOSTORE));
      const p = await get('/sp-public.json');
      assert.equal(p.status, 200);
      assert.equal(p.headers.get('cache-control'), 'public, max-age=86400');
      assert.deepEqual(await p.json(), JSON.parse(PUBLIC));
      // HEAD 也走这条路（只回头，不读体）
      const head = await fetch(`${srv.url}/sp-public.json`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');

      // 未命中：包声明过别的路径不改变任何既有行为（核心静态挂载照旧）
      assert.equal((await get('/sp-not-declared.json')).status, 404);
      assert.equal((await get('/sp-not-declared.js')).status, 404);
      assert.equal((await get('/data/nope.json')).status, 404);

      // 包在**自己的**顶层路径上挂一份文件 ⇒ 命中的就是包那一份（这一条与从前完全一样， §28.40 没动它）
      const claimed = await get('/sp-own-namespace.json');
      assert.equal(claimed.status, 200, '这条路径有文件，所以是包的文件');
      assert.deepEqual(await claimed.json(), { from: 'the pack' });

      // 穿越：编码过的 `..` 解出来还是 `..`，但没有那样的声明路径 ⇒ 落到核心静态层被拒
      for (const path of ['/data/../manifest-pack/pack.json', '/%2e%2e/%2e%2e/etc/passwd', '/data/%2e%2e/manifest-pack/pack.json']) {
        const res = await fetch(`${srv.url}${path}`);
        assert.notEqual(res.status, 200, `${path} 不得被服务`);
        assert.equal(String(await res.text()).includes('"name":"Manifest"'), false, `${path} 不得读到包清单`);
      }
      // 请求侧想直接读包里的文件：pack.json 不在任何声明路径上，核心挂载也到不了 workshop/
      const direct = await get('/manifest-pack/pack.json');
      assert.equal(direct.status, 404);

      // 只读：没有写路径（routes.js 把非 GET/HEAD 挡成 405）
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`${srv.url}/data/resource-manifest.json`, { method });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get('allow'), 'GET, HEAD');
      }
    } finally {
      await srv.close();
    }
  });

  test('关掉工坊（workshopDir: null）时没有任何声明路由，路径回到核心静态行为', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: null });
    try {
      assert.equal((await fetch(`${srv.url}/data/resource-manifest.json`)).status, 404);
      assert.equal((await fetch(`${srv.url}/sp-public.json`)).status, 404);
    } finally {
      await srv.close();
    }
  });

  test('声明引擎已经在服务的路径 ⇒ 这一条被点名拒掉，核心那份文件照旧是核心的内容（§28.40）', async () => {
    const dataFiles = coreDataFiles(join(ROOT, 'data'));
    assert.ok(dataFiles.has('/data/support.json'), '前置：核心目录里真的有这张表（判据的靶子必须在）');

    // 1) 服务层判据本身：包被正常装载，但这条声明进不了表，而且是**点名**报告（不是静默丢掉）。
    const loaded = loadWorkshop(wsBad, { log: quiet });
    assert.equal(loaded.packs.length, 1, '形状层没变：这一格的拒绝发生在服务层，不毁整包');
    const table = workshopRoutesFor(loaded, wsBad, { log: quiet, dataFiles });
    assert.equal(table.routes.has('/data/support.json'), false, '核心已经在服务的路径不得登记');
    assert.equal(table.errors.length, 1, JSON.stringify(table.errors));
    assert.match(table.errors[0].reason, /the engine already serves this path/);
    assert.equal(table.errors[0].pack, 'reserved-claim');

    // 2) 文档用法不能被误伤：`/data/resource-manifest.json` 是 §1.9 举的那个例子，核心没有这个文件。
    assert.ok(!dataFiles.has('/data/resource-manifest.json'), '前置：核心目录里没有这张「作者自己要挂的表」');
    assert.equal(claimsCorePath('/data/resource-manifest.json', { dataFiles }), false, '没有同名核心文件 ⇒ 不是抢');
    assert.equal(claimsCorePath('/data/chess.json', { dataFiles }), true, '有同名核心文件 ⇒ 抢');
    assert.equal(claimsCorePath('/i18n/anything.json', { dataFiles }), true, '其余命名空间按前缀判（那里没有「作者新表」的用法）');
    assert.equal(claimsCorePath('/data', { dataFiles }), true, '裸 `/data` 就是引擎的挂载点');
    assert.equal(claimsCorePath('/datajs/x.json', { dataFiles }), false, '`/data` 的前缀不该把 `/datajs` 也罩进去');
    assert.equal(claimsCorePath('/sp-own.json', { dataFiles }), false, '包自己的顶层路径不受影响');

    // 3) 真服务器：这一格原来会被包整张顶掉（探针实测：官方 1,875,834 字节的表换成 43 字节，还带 public 缓存一天）。
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsBad });
    try {
      const res = await fetch(`${srv.url}/data/support.json`);
      assert.equal(res.status, 200);
      const official = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'support.json'), 'utf8'));
      assert.deepEqual(await res.json(), official, '送出的还是核心那一份 —— 这条断言就是本次改动的全部内容');
    } finally {
      await srv.close();
    }
  });

  test('拒绝码与 A 段同名：`routes` 的形状层判罚一字未改', () => {
    // 这一条只是把「B1 段没有放松 A 段的判罚」钉在路由这一组上（形状层的完整用例表在 test/packAssets.test.js）
    const bad = [
      [{ path: '/a.json', file: 'a.js' }, 'ROUTE_BAD_FILE'],
      [{ path: '/a.json', file: 'a.json', cache: 'forever' }, 'ROUTE_BAD_CACHE'],
      [{ path: 'data/a.json', file: 'a.json' }, 'ROUTE_BAD_PATH'],
    ];
    for (const [route, code] of bad) {
      const root = join(tmp, `shape-${code}`);
      const dir = join(root, 'shape');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id: 'shape', license: 'CC0-1.0', routes: [route] }));
      const loaded = loadWorkshop(root, { log: quiet });
      assert.equal(loaded.packs.length, 0, `${code}: 包整体被拒`);
      assert.equal(loaded.errors.length, 1, JSON.stringify(loaded.errors));
      assert.match(loaded.errors[0].reason, new RegExp(`^${code}:`), loaded.errors[0].reason);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('作者侧校验器（tools/workshop-validate.mjs）也判 §28.40', () => {
  test('声明了引擎已经在服务的路径 ⇒ 校验器报 ROUTE_CLASHES_CORE（不许给作者一个绿色的 VALID）', () => {
    // 判据不抄第二份：校验器 import 的就是服务层那一个 claimsCorePath + coreDataFiles。
    // 这条用例判的是**作者拿到的那句话** —— 服务器会拒的声明，工具不能闭口不说。
    const tool = join(ROOT, 'tools', 'workshop-validate.mjs');
    const r = spawnSync(process.execPath, [tool, wsBad, '--json'], { encoding: 'utf8', timeout: 120_000 });
    const report = JSON.parse(r.stdout);
    const pack = report.packs.find((p) => p.pack === 'reserved-claim');
    assert.ok(pack, '这份包要被扫到：' + JSON.stringify(report.packs.map((p) => p.pack)));
    const hit = pack.issues.find((i) => i.code === 'ROUTE_CLASHES_CORE');
    assert.ok(hit, JSON.stringify(pack.issues));
    assert.equal(hit.severity, 'error', '服务器会整条丢了它，工具这边不能只是提示');
    assert.match(hit.message, /\/data\/support\.json/);
    assert.equal(r.status, 1, '有 error 就该非零退出（与既有的校验器口径一致）');
  });

  test('文档例子那条路径（/data/resource-manifest.json，核心没有同名文件）在校验器里仍然是干净的', () => {
    const tool = join(ROOT, 'tools', 'workshop-validate.mjs');
    const r = spawnSync(process.execPath, [tool, wsRoot, '--json'], { encoding: 'utf8', timeout: 120_000 });
    const report = JSON.parse(r.stdout);
    const pack = report.packs.find((p) => p.pack === 'manifest-pack');
    assert.ok(pack, JSON.stringify(report.packs.map((p) => p.pack)));
    assert.deepEqual(pack.issues.filter((i) => i.field === 'routes'), [], '§1.9.2 举的例子不许被自己的收紧打断');
  });
});

