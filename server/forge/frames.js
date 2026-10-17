// server/forge/frames.js —— **把 Forge 的 `client.panels` 转译成 0.3.0 的 ui frame**。
//
// 为什么要转译（审计结论）：
//   * Forge 的面板是一个 **ES 模块**（`export async function mount(ctx)` / `export default mount`），
//     由引擎在**自己的槽位系统**里挂载，`ctx` 至少给 `host`（DOM 节点）与 `log`；
//   * 0.3.0 的 ui 插件是**独立 HTML 页面**（iframe），靠 `postMessage` 协议通信
//     （`welcome` → 回 `ready`，之后收 `{v:1,t:...}` 数据帧），且 `entry.client` 必须是 `.html`，
//     frame 只能引用**同一个目录**下的文件（`shared/plugins/manifest.js:703/797`）。
//
// 所以转译 = 在**面板模块同一个目录**里生成一个 `.frame.html`：它完成 0.3.0 的握手，再用 `import()` 载入原模块、
// 调 `mount(ctx)`，把 `ctx.host` 指向一个容器。模块与 frame 同目录 ⇒ 天然满足「同目录」这条约束，且**不改包内容**。
//
// 槽位：两套词表**不重叠**（0.3.0 只有 hud.right / result.tab / stats.tab / room.panel；
// Forge 有 root.overlays / root.guide / screen.game.hud 等九个）。没有对应物的一律落到 `room.panel`
// （房间内的通用面板），并在 `notes` 里**点名**写出这次替换 —— 不静默丢位置。

/** 0.3.0 的槽位闭集（`shared/plugins/manifest.js` UI_SLOT_IDS 的四项）。 */
export const SP_UI_SLOTS = Object.freeze(['hud.right', 'result.tab', 'stats.tab', 'room.panel']);

/**
 * Forge 槽位 → 0.3.0 槽位。**只映射语义真的接近的那几个**；其余显式回落到 `room.panel`。
 * 这张表是审计结论的落点：两套词表不重叠，所以"映射"本身是一次**取舍**，必须写出来。
 */
export const SLOT_MAP = Object.freeze({
  'screen.game.hud': 'hud.right',          // 局内右侧信息位
  'screen.result.footer': 'result.tab',    // 结算页
  'root.overlays': 'room.panel',           // 房间浮层 → 房间内通用面板
  'root.guide': 'room.panel',              // 说明/引导 → 房间内通用面板
  'screen.game.aside': 'room.panel',
  'screen.game.overlay': 'room.panel',
  'screen.game.bondStrip': 'room.panel',
  'screen.loadout.detail': 'room.panel',
  'screen.game.shopCard': 'room.panel',    // 可重复宿主在 0.3.0 没有对应物
});

/** 一个 Forge 槽位到 0.3.0 槽位的结果（带"是否原样映射"）。 */
export function mapSlot(slot) {
  const mapped = SLOT_MAP[slot] || null;
  if (!mapped) return { slot: 'room.panel', exact: false, from: slot };
  return { slot: mapped, exact: slot !== 'screen.game.shopCard' && mapped !== 'room.panel', from: slot };
}

/** 面板模块旁边的 frame 路径：`ui/panel.js` → `ui/panel.frame.html`。 */
export function framePathFor(moduleRel) {
  const rel = String(moduleRel || '').replace(/\\/g, '/');
  const cut = rel.lastIndexOf('/');
  const dir = cut >= 0 ? rel.slice(0, cut + 1) : '';
  const base = cut >= 0 ? rel.slice(cut + 1) : rel;
  const stem = base.replace(/\.[^./]+$/, '');
  return `${dir}${stem}.frame.html`;
}

/**
 * 生成 frame 的 HTML。
 *
 * 三条硬要求，缺一条这个 frame 在 0.3.0 里就是"装了但什么都不显示"：
 *   1. `welcome` ⇒ `parent.postMessage({v:1,t:'ready'})`（不握手，宿主不会应用任何数据帧）；
 *   2. `import()` **相对路径**载入原模块（frame 与模块同目录）；
 *   3. `mount(ctx)` 拿到 `ctx.host`（容器）、`ctx.log`，并把 0.3.0 的数据帧转成 `ctx.onMessage`（模块支持时才调）。
 */
export function frameHtml({ moduleRel, title = '', styles = [] }) {
  const mod = moduleRel.split('/').pop();
  const css = (Array.isArray(styles) ? styles : [])
    .filter((s) => typeof s === 'string' && s)
    .map((s) => `<link rel="stylesheet" href="./${s.split('/').pop()}">`)
    .join('\n');
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;background:transparent;color:#e8e0d0;font:12px/1.4 sans-serif}body{padding:4px 6px}#sp-host{min-height:8px}</style>
${css}
</head>
<body>
<div id="sp-host"></div>
<script type="module">
// 由 tools/… 的转译器生成：把 Forge 的 mount(ctx) 面板装进 0.3.0 的 ui frame 协议。
const host = document.getElementById('sp-host');
const log = { info: (...a) => console.info(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };
let onMessage = null;
let unmount = null;

// 1) 0.3.0 的握手：收到 welcome 必须回 ready，否则宿主不投递数据帧
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || m.v !== 1 || typeof m.t !== 'string') return;
  if (m.t === 'welcome') { try { parent.postMessage({ v: 1, t: 'ready' }, '*'); } catch {} return; }
  if (typeof onMessage === 'function') { try { onMessage(m); } catch (e) { log.error(e); } }
});

// 2) 载入原面板模块并挂载
try {
  const mod = await import('./${mod}');
  const mount = (typeof mod.mount === 'function' ? mod.mount : (typeof mod.default === 'function' ? mod.default : null));
  if (!mount) { host.textContent = '这个面板没有导出 mount(ctx)，无法在 0.3.0 的 frame 里运行。'; }
  else {
    const result = await mount({
      host,
      log,
      onMessage: (fn) => { onMessage = fn; },
      // Forge 的 ctx 还有 store / session 等；0.3.0 的 frame 不给这些（ui 插件只读允许的对局信息），
      // 所以这里**不伪造**它们 —— 面板若依赖它们，会在自己的 try/catch 里如实报错。
      spVersion: 1,
    });
    if (result && typeof result.unmount === 'function') unmount = result.unmount;
  }
} catch (e) {
  host.textContent = '面板载入失败：' + String((e && e.message) || e);
  log.error(e);
}
window.addEventListener('pagehide', () => { try { unmount?.(); } catch {} });
</script>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 一个包的全部 ui 转译计划：每个面板一条 `{ slot, exact, module, frame, html }`。
 * 面板声明不合法（没 module / 不在包内）⇒ 收进 `notes`，**不静默丢**。
 */
export function planUiFrames(pack) {
  const client = pack.manifest && pack.manifest.client;
  const panels = client && Array.isArray(client.panels) ? client.panels : [];
  const frames = [];
  const notes = [];
  const files = new Set((pack.files || []).map((f) => f.path));
  for (const p of panels) {
    const moduleRel = p && typeof p.module === 'string' ? p.module.replace(/\\/g, '/') : '';
    if (!moduleRel) { notes.push(`面板 ${p && p.id ? p.id : '(未命名)'} 没有 module，跳过`); continue; }
    if (!files.has(moduleRel)) { notes.push(`面板 ${p.id || moduleRel} 的模块 ${moduleRel} 不在包里，跳过`); continue; }
    const mapped = mapSlot(p.slot);
    frames.push({
      id: p.id || framePathFor(moduleRel),
      from: p.slot,
      slot: mapped.slot,
      exact: mapped.exact,
      module: moduleRel,
      frame: framePathFor(moduleRel),
      html: frameHtml({ moduleRel, title: p.title || pack.manifest.name || pack.id, styles: p.styles }),
    });
    if (!mapped.exact) notes.push(`面板 ${p.id || moduleRel}：槽位 ${p.slot} 在 0.3.0 没有对应物，落到 ${mapped.slot}`);
  }
  return { frames, notes };
}
