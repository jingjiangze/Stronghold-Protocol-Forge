# 在 0.3.0 上跑 Forge 工坊包（MOD-PROJECT）

这一份讲**这条线**（`feat/forge-packs-on-030`）怎么让 Forge 的 `pack.json` 包在官方 0.3.0 上跑起来，
以及作者/运维各自要做什么。

> 上游 0.3.0 自己的插件格式见 `docs/PLUGINS.md`；包格式见 `docs/WORKSHOP.md` / `docs/STANDARD-PACK.md`。
> 本文只说**这条线新增的那些桥**。

---

## 1. 一条链，不是两条

包不是"另开一条装载路径"，而是被**合成为 0.3.0 认识的插件记录**，进入同一个 `plugins[]`：

```text
scanPlugins(plugins/, public/i18n/, packs/)   ← 上游
      +
scanForgePacks(workshop/)                    ← 本线（server/forge/compose.js）
      ↓ packToPlugin(pack)
一个 plugins[]  →  contentSet(cs)  →  room.setPlugins  →  consent  →  contentReady  →  开赛
```

所以「这一局跑什么」仍然只有一份答案：房间点名了哪些包、全员同意、`cs` 校验，全部复用 0.3.0 既有机制。

## 2. 包 → 插件：合成规则

| 包声明 | 合成出的插件 |
|---|---|
| 内容表 `content: ['chess','items']` | `class: content`，`parts.data.files`，每条记录以 `forge:1` 形式进内容集 |
| `client.panels/screens/styles` | `class: ui`，并**转译出 `.frame.html`**（见 §3） |
| `assets / art / skins / voices` | `class: cosmetic`（素材容器这一格尚未接线，见 §5） |
| `server.modules / battle / meta / room` | `class: trusted` + `trusted.server`（房间选中才执行，见 §4） |
| 包目录每个文件 | `[path, sha256]` 排序哈希 → 插件身份 |

**记录模型**：0.3.0 的插件记录是紧凑补丁（`{file,id,base/set/value}`），表达不了 Forge 那种**引擎格式的整条
记录**。本线给 `RECORD_SCHEMA` 加了一支 `forge:1`（`{file,id,forge:1,record,replace?}`），并让
`records.js` 直接写入 `data[file][id]`。

**覆盖策略（业主裁决：信任工坊包）**：工坊包可以覆盖已存在的记录；只要选区里混了官方插件，
`validateData` 的字段级判据就保持严格 —— 不让一条信任策略顺带放宽官方插件。

## 3. ui 面板：转译成 frame

Forge 面板是 `export async function mount(ctx)` 的 ES 模块；0.3.0 的 ui 插件是独立 HTML 且只能引用**同目录**文件。
转译器在**面板模块同一目录**生成 `<stem>.frame.html`：握手（`welcome` ⇒ `ready`）、相对 import、调 `mount(ctx)`。

槽位两套词表不重叠，映射只对语义接近的生效（`screen.game.hud→hud.right`、`screen.result.footer→result.tab`），
其余落到 `room.panel` 并**逐个点名**。

## 4. 服务端载荷

`server.modules / battle / meta / room` 在房间**选中该包**时才执行；未开 `SP_PLUGIN_SCRIPTS` 时不执行且具名报出。

## 5. 当前边界（诚实清单）

| 项 | 状态 |
|---|---|
| 内容表（19 个包） | ✅ 全链通过 |
| ui 面板（24 个包 / 27 个 frame） | ✅ 转译生成 100% |
| 服务端载荷（7 个包） | ⏳ 阶段 3：房间门控适配器 |
| 素材容器 `.spresources`（18 个包） | ⏳ 需要单独的资源通道；上游 `forgeImport.js:132` 明写"不能导入" |
| 拖目录安装 | ✅ `server/forge/inbox.js`（`workshop/*.zip` 与 `workshop/.forge-inbox/*.zip`） |

## 6. 装上 ≠ 启用

包被装进 `workshop/<id>/` 只是**安装**；0.3.0 的语义是**房间点名才生效**（`room.setPlugins`），
全员 `consent` + `contentReady` 才开赛。这比"装完即启用"更严，也是本线的默认。
