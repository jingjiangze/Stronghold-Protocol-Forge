# 魔塔 delta 层交接单

日期：2026-10-18　分支：`feat/mota-delta`（**本地，未推送**）　作者：本会话

> 本会话按用户要求**不提交、不推送、不部署**。下面是要交给另一个对话提交与部署的东西。

## 1. 仓库状态

- 基线：`master`（= 0.3.1 + 模组管理器，`167b8f55`）
- 分支：`feat/mota-delta`，本地 5 个提交（**全部未推送**）：
  - `741da304` 机制：`tools/mota-overlay.mjs` + 配置 + 测试 + 裁决清单
  - `a680ae68` 裁决落地：READY=true，6 个服务端挂载点手合并
  - `02797fc0` 文档：叠模组管理器步骤
  - `ad2a0907` 来源换 `ms-work3` + `tools/mota-post-compose.mjs`
  - `f237b402` 无损插件化审计
- 工作区还有 **2 项未提交**（本次会话产出，请一并提交）：
  - `.gitignore`（把 `.mota-delta/` 改成只忽略报告，`resolved/` 进库）
  - `.mota-delta/resolved/**`（33 个文件：人工合并产物，**这是资产，必须进库**）

提交命令（由另一个对话执行）：

```bash
cd "C:/DDDD/Agent Work/_tmp/mota-031-2026-10-18/repo"
git add .gitignore .mota-delta/resolved config tools docs test
git -c commit.gpgsign=false commit -m "feat(mota-delta): 合并产物入库（resolved 层 33 个文件）"
```

> ⚠️ 提交时不要带 `.mota-delta/*.json`、`.mota-delta/*.mjs`、`*.new`（已被 `.gitignore` 挡住）；`config/mota-delta.local.json` 含本机路径，同样不进库。

## 2. 部署产物怎么来

产物不是仓库里的文件，而是 **compose 出来的树**：

```bash
cd "C:/DDDD/Agent Work/_tmp/mota-031-2026-10-18/repo"
node tools/mota-overlay.mjs audit  --source "C:/DDDD/Agent Work/_tmp/ms-work3"   # 期望 READY=true
node tools/mota-overlay.mjs compose --source "C:/DDDD/Agent Work/_tmp/ms-work3" --out ../composed2
node tools/mota-post-compose.mjs --tree ../composed2 --source "C:/DDDD/Agent Work/_tmp/ms-work3"
```

`post-compose` 会补齐三样不属于 delta 的东西：本机素材包（75 MB，`public/assets/local`）、`/assets/local/` 的 CDN 分流豁免、模组管理器（`/mod`），以及 `node_modules` 链接。

启动：

```bash
cd ../composed2 && PORT=3011 HOST=0.0.0.0 node server/index.js
```

## 3. 本次验证记录（PASS）

| 项 | 结果 |
|---|---|
| `audit`（base=v0.3.0，ours=v0.3.1，theirs=ms-work3） | 17 上游未动 / 110 魔塔独有 / 30 自动合并 / 34 冲突 / 6 add/add；**READY=true** |
| 服务端 | `/healthz` 200（本机与局域网均 200），`/mod` 200 |
| 浏览器 | 控制台 **0 错误**、0 失败请求；大厅 → hub → 独立模拟 → INFO_CHECK → BAND_CHECK → 整备 全渲染 |
| 新经济三项 | `econDefenceReward`（联防两档）、`econBuyTime`（赏金加时）、`pickBossStage`（每回合换图）均在树里 |
| 棋盘素材 | `/assets/local/map/autochess/tiles.json` 200（8.7 KB），`TX_autochessi_D.webp` 200（685 KB） |
| 协议 | `room.create` 用上游 `{mode:'solo'|'coop', difficulty:'NORMAL'}`；`coop+xie` 的 `m.public.econ` 存在 |

## 4. 已知问题（PENDING，不是本次合并引入）

1. **BGM 404**：`/media/bgm/m_sys_act1autochess_intro|loop` 404。素材清单里它们在 `/assets/audio/bgm/*.mp3`（走 CDN 正常），是媒体路由没接分流，属既有问题。
2. **战斗/复活未实战**：只推进到整备期，COMBAT、结算、复活 30 秒窗口未点完。
3. **6 个 add/add 文件**（`settle.js`/`sweep.js`/`matchPopups.js`/`screenFit.js`/`skinPicker.js`/`skins.js`）过了语法与加载验证，未逐页视觉验收。
4. **玩法自身缺口**（来自新经济会话，未修）：COMBAT/UNITE 直接赋值 deadline 可能卡死、空 fields 无看门狗、接管无玩家提示、赏金按钮视觉未目检。
5. **`match.queue`/`match.cancel`** 未并入协议，大厅的快速匹配会 `BAD_MSG`。

## 5. 下次上游更新怎么办

```bash
git fetch upstream --tags                 # latest 自动前移（当前 v0.3.1）
node tools/mota-overlay.mjs audit         # 只看新出现的冲突
node .mota-delta/refresh.mjs              # 来源自身有更新时，把增量再合进 resolved（一次性，勿重复跑）
node tools/mota-overlay.mjs compose … && node tools/mota-post-compose.mjs …
```

`refresh.mjs` 不是幂等的：它用「旧来源 → 新来源」的增量去合 resolved；同一份来源不要跑第二遍（第二次会把已合并的结果当基线，报假冲突）。

## 6. 边界

- 本会话**不执行** `git commit` / `git push` / 部署 / 改线上。
- 产物目录 `composed2` 不要提交进仓库（2092 文件 + 75 MB 素材）。
- 部署到哪台机器、用什么域名，由另一个对话按 `publishing-standards` 决定。
