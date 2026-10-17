// server/forge/adapters/index.js —— **Forge 兼容层的适配器注册表**（可单独装卸）。
//
// 为什么要注册表：Forge 的包面是"一格一件事"（内容表 / 面板 / 素材容器 / kits / 服务端载荷 / 口径开关…），
// 而 0.3.0 只原生支持其中一部分。把每一格做成**独立适配器**，好处是：
//   * 每一格可以单独**关掉**（`SP_FORGE_ADAPTERS=content,ui`）：一个还没接线的通道不会拖累其它通道；
//   * 每一格有自己的 `status`，`planned` 就是**明确没做**，不会伪装成"跑起来了"；
//   * 卸载/添加 = 从注册表里删/加一条，不需要动别处的分支判断。
//
// 适配器接口（每一条都一样）：
//   { id, summary, surfaces[], status: 'done'|'planned', appliesTo(pack) => boolean, plan(pack, ctx) => any }
//
// 注意：`plan()` **只做规划**，不执行任何包内代码。执行在各自的 host 里（载荷由房间门控调用）。

/**
 * @typedef {{ id: string, summary: string, surfaces: string[], status: 'done'|'planned',
 *   appliesTo: (pack: any) => boolean, plan: (pack: any, ctx?: any) => any }} ForgeAdapter
 */

/** 内容表 → 0.3.0 的 contentSet（forge:1 记录）。 */
export const contentAdapter = {
  id: 'content',
  summary: '包的内容表合成为 forge:1 记录，进 0.3.0 的 contentSet（cs）',
  surfaces: ['content'],
  status: 'done',
  appliesTo: (pack) => Array.isArray(pack?.manifest?.content) && pack.manifest.content.length > 0,
  plan: (pack) => ({
    tables: (pack.manifest.content || []).filter((t) => pack.content?.documents?.[`${t}.json`]),
    frames: [],
    documents: Object.keys(pack.content?.documents || {}),
  }),
};

/** client.panels → 转译成 ui frame（同目录 .frame.html）。 */
export const uiAdapter = {
  id: 'ui',
  summary: 'client.panels 的面板模块转译成 0.3.0 的 .frame.html',
  surfaces: ['client.panels', 'client.screens', 'client.styles'],
  status: 'done',
  appliesTo: (pack) => Array.isArray(pack?.manifest?.client?.panels) && pack.manifest.client.panels.length > 0,
  plan: (pack, { planFrames } = {}) => planFrames(pack),
};

/** 素材容器（.spresources）→ **单独的资源通道**（不能走插件的 visual 叠加）。 */
export const cosmeticAdapter = {
  id: 'cosmetic',
  summary: 'assets/art/skins/voices 的资源容器挂到专用的资源通道上（不是插件的 visual 叠加）',
  surfaces: ['assets', 'art', 'skins', 'voices'],
  status: 'planned',
  // 只在**真的有资源容器**时命中：voices/skins 之类纯声明不需要这条通道，命中它们只会刷出无意义的'未接线'备注。
  appliesTo: (pack) => !!((pack?.manifest?.assets && pack.manifest.assets.container)
    || (pack?.files || []).some((f) => /.spresources$/i.test(f && f.path ? f.path : ''))),
  plan: (pack) => {
    const m = pack.manifest;
    const containers = [];
    if (m.assets && typeof m.assets === 'object' && m.assets.container) containers.push({ kind: 'assets', file: m.assets.container, manifest: m.assets.manifest || null });
    for (const f of (pack.files || [])) {
      const rel = f && f.path ? f.path : '';
      if (/\.spresources$/i.test(rel) && !containers.some((c) => c.file === rel)) containers.push({ kind: 'container', file: rel, manifest: null });
    }
    return {
      containers,
      // 上游已经判过这条路：forgeImport.js:132 —— 资源容器"不是一张能叠加的图，不能导入"。
      // 所以这里如实写明还差什么，而不是假装它有 visual。
      blockedBy: '0.3.0 的插件模型只有"叠加式素材清单"（visual overlay）；资源容器要一条**替换引擎资源**的通道，本版未实现',
      counts: { voices: Number(m.voices ? Object.keys(m.voices).length : 0), skins: Array.isArray(m.skins) ? m.skins.length : 0 },
    };
  },
};

/**
 * 服务端载荷（modules / battle / meta / room）→ **按房间选中才执行**。
 * 这一格是阶段 3：`plan()` 只产出描述符；真正执行由 `applyPayloads()` 在房间装配时按选中集合调用。
 */
export const payloadAdapter = {
  id: 'payloads',
  summary: 'server.modules/battle/meta/room 按房间选中执行；未开 SP_PLUGIN_SCRIPTS 时不执行且点名',
  surfaces: ['server.modules', 'server.battle', 'server.meta', 'server.room'],
  status: 'done',
  appliesTo: (pack) => {
    const s = pack?.manifest?.server;
    if (!s || typeof s !== 'object') return false;
    return ['modules', 'battle', 'meta', 'room'].some((k) => (Array.isArray(s[k]) ? s[k].length > 0 : !!s[k]));
  },
  plan: (pack, { scriptsEnabled = false } = {}) => planPayloads(pack, { scriptsEnabled }),
};

/** 注册表。顺序 = 规划时的固定顺序（有测试钉住）。 */
export const ADAPTERS = Object.freeze([contentAdapter, uiAdapter, cosmeticAdapter, payloadAdapter]);

/** 环境开关：`SP_FORGE_ADAPTERS=content,ui` 只开这两格；缺省全开。 */
export function enabledAdapters(env = process.env, { log = null } = {}) {
  const raw = env.SP_FORGE_ADAPTERS;
  if (raw === undefined || String(raw).trim() === '') return ADAPTERS.map((a) => a.id);
  const want = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(ADAPTERS.map((a) => a.id));
  for (const w of want) if (!known.has(w)) log?.warn?.(`[forge] SP_FORGE_ADAPTERS names unknown adapter "${w}" (known: ${[...known].join(', ')})`);
  return want.filter((w) => known.has(w));
}

/** 这个包命中哪些适配器（只算"声明了对应面"的那些）。 */
export function adaptersFor(pack, { enabled = null } = {}) {
  const allow = enabled ? new Set(enabled) : null;
  return ADAPTERS.filter((a) => (!allow || allow.has(a.id)) && safeApplies(a, pack));
}

function safeApplies(a, pack) {
  try { return a.appliesTo(pack); } catch { return false; }
}

/**
 * 规划一个包：`{ id, adapters: [{ id, status, result }], notes }`。不执行任何包内代码。
 */
export function planPack(pack, ctx = {}) {
  const out = { id: pack?.id ?? null, adapters: [], notes: [] };
  for (const a of adaptersFor(pack, { enabled: ctx.enabled })) {
    let result = null;
    try { result = a.plan(pack, ctx); } catch (e) { out.notes.push(`${a.id}: plan 失败 ${e && e.message ? e.message : e}`); continue; }
    out.adapters.push({ id: a.id, status: a.status, result });
    if (a.status === 'planned') out.notes.push(`${a.id}: 本版未接线 —— ${result && result.blockedBy ? result.blockedBy : '计划中'}`);
  }
  return out;
}

// ---- 服务端载荷：规划 + 房间门控执行 -------------------------------------------------------------

const PAYLOAD_KINDS = ['modules', 'battle', 'meta', 'room'];

/**
 * 一个包的载荷描述符（**不执行**）。`scriptsEnabled=false` 时每一条都标 `skipped` 并给原因 ——
 * 调用方必须把 `skipped` 报出来，不许静默吞掉（"装了但没反应"是本仓库最恨的形态）。
 */
export function planPayloads(pack, { scriptsEnabled = false } = {}) {
  const s = pack?.manifest?.server;
  const entries = [];
  const skipped = [];
  if (!s || typeof s !== 'object') return { entries, skipped };
  for (const kind of PAYLOAD_KINDS) {
    const v = s[kind];
    const list = Array.isArray(v) ? v : (v ? [v] : []);
    if (!list.length) continue;
    if (!scriptsEnabled) {
      skipped.push({ kind, reason: 'SP_PLUGIN_SCRIPTS 未开启：服务端代码不执行（装上也不会跑）' });
      continue;
    }
    for (const item of list) entries.push({ kind, pack: pack.id, entry: item });
  }
  return { entries, skipped };
}

/**
 * **按房间选中执行**载荷：`selected` 是这一局选中的包 id 集合。
 * 返回 `{ invoked: [], skipped: [], notSelected: [] }` —— 没被选中的包**一次都不会被调用**（这条有测试）。
 *
 * @param {{ selected: Set<string>|string[], plans: Map<string, any>, invoke: (entry: any, ctx?: any) => any }} opts
 */
export function applyPayloads({ selected, plans, invoke = () => {} }) {
  const chosen = selected instanceof Set ? selected : new Set(selected || []);
  const invoked = [], skipped = [], notSelected = [];
  for (const [packId, plan] of plans) {
    if (!chosen.has(packId)) { notSelected.push(packId); continue; }
    for (const entry of plan.entries || []) {
      try { invoke(entry); invoked.push(entry); } catch (e) { skipped.push({ ...entry, reason: String(e && e.message ? e.message : e) }); }
    }
    for (const s of plan.skipped || []) skipped.push({ ...s, pack: packId });
  }
  return { invoked, skipped, notSelected };
}
