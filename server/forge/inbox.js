// server/forge/inbox.js —— **把 zip 拖进目录就装上**（0.3.0 线的投递层）。
//
// 为什么在这一层而不是写个 HTTP 上传端点：
//   * 「把文件拖进文件夹」是**本机文件系统操作** —— 能往这个目录写文件的人，本来就对这台机器有写权限，
//     不给远程攻击者新增任何入口；
//   * 0.3.0 的 zip 读取器 `readPluginZip` 已经把不可信归档的每一类问题都具名拒绝了
//     （zip-slip、绝对路径、盘符、反斜杠、隐藏段、`..`、大小写冲突、符号链接、ZIP64、超限），直接复用。
//
// 三步，顺序是有意的（与 0.2.6 线的 installZip 同一条纪律）：
//   1. 解到 `<workshopRoot>/.forge-import-XXXX/`（**同一个卷**，所以第 3 步是原子 rename）；
//   2. 在临时目录里用 `readForgePack` 校验清单（与扫描器同一个函数）；
//   3. 只有前两步都过了才搬到 `workshop/<id>/` ⇒ 坏包/恶意包**永远不留半个包**。

import fs from 'node:fs';
import path from 'node:path';

import { readPluginZip } from '../plugins/zip.js';
import { readForgePack } from './compose.js';

export const INBOX_DIRNAME = '.forge-inbox';

/** 归档里包根的位置：'' = pack.json 在根；否则是唯一带 pack.json 的顶层目录（含尾 `/`）。 */
export function packPrefix(names) {
  if (names.includes('pack.json')) return '';
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const dirs = [...tops].filter((t) => names.includes(`${t}/pack.json`));
  if (dirs.length === 1 && tops.size === 1) return `${dirs[0]}/`;
  if (dirs.length > 1) throw Object.assign(new Error(`归档里有多个顶层目录带 pack.json（${dirs.join('、')}）：无法判断哪个是包`), { code: 'FORGE_LAYOUT' });
  throw Object.assign(new Error('归档里没有 pack.json（既不在根，也没有唯一的顶层目录包含它）'), { code: 'FORGE_LAYOUT' });
}

/**
 * 装一个工坊包 zip 到 `workshop/<id>/`。
 * @param {{ workshopRoot: string, buffer: Buffer, force?: boolean }} opts
 * @returns {{ id: string, dir: string, files: number, bytes: number }}
 */
export function installPackZip({ workshopRoot, buffer, force = false }) {
  const entries = readPluginZip(buffer);   // 不可信归档的每一类问题都在这里具名拒绝
  const names = entries.map((e) => e.name);
  const prefix = packPrefix(names);

  fs.mkdirSync(workshopRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(workshopRoot, '.forge-import-'));
  const packDir = path.join(staging, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  try {
    let bytes = 0;
    for (const e of entries) {
      if (prefix && !e.name.startsWith(prefix)) continue;
      const rel = prefix ? e.name.slice(prefix.length) : e.name;
      if (!rel || rel.endsWith('/')) continue;
      // readPluginZip 已经把名字判过一遍；这里再按路径段落盘，绝不拼出包外的位置
      const abs = path.join(packDir, ...rel.split('/'));
      if (!abs.startsWith(packDir + path.sep)) throw Object.assign(new Error(`${e.name} 会写到包目录之外`), { code: 'FORGE_LAYOUT' });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.data);
      bytes += e.data.length;
    }
    // 与扫描器同一个函数：这里给绿，`scanForgePacks` 就一定会收
    const checked = readForgePack(packDir, { id: '' });
    if (checked.errors && checked.errors.length) {
      throw Object.assign(new Error(`${checked.errors[0].code}: ${checked.errors[0].reason}`), { code: checked.errors[0].code });
    }
    const id = checked.manifest.id;
    const target = path.join(workshopRoot, id);
    if (fs.existsSync(target) && !force) {
      throw Object.assign(new Error(`工坊包 "${id}" 已经存在：要覆盖请显式 force`), { code: 'FORGE_EXISTS' });
    }
    // 原子替换：先把旧的挪开再放新的，失败时把旧的放回去
    let displaced = null;
    if (fs.existsSync(target)) {
      displaced = fs.mkdtempSync(path.join(workshopRoot, '.forge-replaced-'));
      fs.renameSync(target, path.join(displaced, 'old'));
    }
    try {
      fs.renameSync(packDir, target);
    } catch (e) {
      if (displaced) { try { fs.renameSync(path.join(displaced, 'old'), target); } catch { /* 放不回去就报错 */ } }
      throw e;
    } finally {
      if (displaced) { try { fs.rmSync(displaced, { recursive: true, force: true }); } catch { /* 留底失败不影响安装 */ } }
    }
    return { id, dir: target, files: checked.files.length, bytes };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 待安装的 zip（工坊根下与 `.forge-inbox/` 下，都不递归）。 */
export function pendingInbox(workshopRoot) {
  const out = [];
  for (const dir of [workshopRoot, path.join(workshopRoot, INBOX_DIRNAME)]) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.zip') && !d.name.startsWith('.'))
        .map((d) => d.name).sort();
    } catch { continue; }
    for (const n of names) if (!out.some((p) => path.basename(p) === n)) out.push(path.join(dir, n));
  }
  return out;
}

/** 把处理完的 zip 搬进 `installed/` 或 `failed/`（搬而不是删；失败留 `.reason.txt`）。 */
function stash(workshopRoot, kind, file, reason = null) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(workshopRoot, INBOX_DIRNAME, kind);
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, `${Date.now()}-${path.basename(file)}`);
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(dir, `${Date.now()}-${n++}-${path.basename(file)}`);
  try { fs.renameSync(file, dest); } catch { try { fs.copyFileSync(file, dest); fs.unlinkSync(file); } catch { return null; } }
  if (reason) { try { fs.writeFileSync(`${dest}.reason.txt`, `${reason}\n`, 'utf8'); } catch { /* 留底失败不影响主流程 */ } }
  return dest;
}

/**
 * 处理当前队列（串行）。**结论定了才搬文件** —— 重试期间源文件必须还在原地。
 * @returns {Array<{ file: string, ok: boolean, id?: string, reason?: string, movedTo?: string }>}
 */
export function drainInbox(workshopRoot, { report = () => {} } = {}) {
  const results = [];
  for (const file of pendingInbox(workshopRoot)) {
    let out;
    try {
      const r = installPackZip({ workshopRoot, buffer: fs.readFileSync(file), force: false });
      out = { file: path.basename(file), ok: true, id: r.id, files: r.files, bytes: r.bytes, movedTo: stash(workshopRoot, 'installed', file) };
    } catch (e) {
      out = { file: path.basename(file), ok: false, reason: e && e.message ? e.message : String(e) };
      out.movedTo = stash(workshopRoot, 'failed', file, out.reason);
    }
    results.push(out);
    report(out);
  }
  return results;
}
