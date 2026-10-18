# 完整服务器源码挂载：审计与执行方案

审计日期：2026-10-18  
目标分支：`chatgpt`  
范围：只改 `jingjiangze/Stronghold-Protocol-Forge`。不向 `jingjiangze/stronghold-server`、`jingjiangze/stronghold-server-server-agent` 或 `sganggs/Stronghold-Protocol` 写入任何提交。

## 1. 审计基线

| 对象 | 实际基线 | 当前判定 |
|---|---|---|
| Forge 管理器 | `master` = `3dd6ba602fd96a5002f142d7387dcef0a472f8fb`；应用版本 0.18.8 | BASELINE |
| 上游游戏 | `sganggs/Stronghold-Protocol@master` = `d905c1464f762a03d236c7ad6bc3ba31a74f4494` | BASELINE |
| 完整服务器仓库 | `jingjiangze/stronghold-server@master` = `48f8cff8277060a4da489f4f19658fcd05ebd145`；应用版本 0.2.5 | BASELINE |
| Agent 服务器仓库 | `jingjiangze/stronghold-server-server-agent@master` = `d16ce8bd158aee31b74ac34635a585a7bdb5fe05`；应用版本 0.2.6 | BASELINE |
| 保护边界 | Forge 的 `.github/manager-only-check.mjs` 与 `.github/game-overlap-check.mjs` 会检查管理器层越界及对上游同路径的改动 | BASELINE |

### 已核实的结构事实

1. Forge 目前的 `server/modServer.js`、`server/modModules.js`、`shared/workshop.js` 与 `public/js/ui/extensions.js` 属于 Forge 自己的运行时。其扩展契约围绕 `pack.json`、面板槽、服务端模块和包通道建立。
2. 两个用户仓库都以 `server/index.js` 为完整服务入口，并包含完整的游戏服务器、协议、客户端 HTML/CSS/JS、对局逻辑及数据；不是可互换的 Forge 工坊包。源码树比较发现二者大量共享相同路径，但对应文件有独立修改。
3. `stronghold-server` 相对其已存在的同步基线包含 40 个提交、105 个文件差异；差异覆盖 `server/`、`shared/`、`public/js/`、`public/css/`、数据与部署，不是单一功能插件。
4. `stronghold-server-server-agent` 包含独立的真人布阵学习库、outbox、发布/同步代码及其游戏侧接线；它仍是完整游戏运行时，不是一个可单独启动后安全注入另一个服务器的无状态 worker。
5. 两个用户仓库都绑定完整 HTTP 首页和 `/ws` 游戏 WebSocket 路径，且文件级差异涉及共同文件。对它们直接做目录覆盖、将玩法拆成包、或不经审查地把一个仓库复制到另一个仓库，都会有覆盖 UI/玩法或错接协议的风险。
6. 当前 Forge 管理器的 `server/modServer.js` 不能直接启动这两个仓库：它调用的是 Forge 版本的 `startServer()` 和 Forge 的 Mod API；用户仓库并未提供同一套模块契约。
7. 仓库提交历史不是可直接依赖的标准三方合并基线：当前可检索的用户仓库历史未提供可用的共同合并祖先。因此不能把自动 `git merge` 当成安全兼容方案。

## 2. 根因

之前的方向把“完整游戏服务器源码”降格为“玩法插件”。但完整玩法不是单一挂载点：回合状态机、经济、战斗模拟、玩家视图、客户端屏幕、协议和资源寻址彼此耦合。即使某个插件可以通过 Forge 的现有 ABI 装载，也不能因此保证完整保留原仓库里所有玩法和 UI。

## 3. 方案决定

采用 **完整源码运行时配置（Source Runtime Profile）**，而不是把用户玩法重写成 Forge 包。

- 将两个仓库登记为独立的一等运行时配置，分别固定到审计时的 commit SHA。
- 安装到用户目录下的隔离运行时缓存，不在源仓库或 Forge 工作树内执行 `npm ci`，也不把生成的依赖、vendor 文件、锁文件或部署产物写回源仓库。
- 按原样运行所选配置的 `server/index.js`。管理器只负责版本固定、源文件完整性检查、依赖准备、进程生命周期、日志和 HTTP/WebSocket 透明代理；不改写选中运行时的游戏代码。
- 公开端口由管理器代理，游戏 HTTP 路径、静态 UI 和 WebSocket 路径保持原样；反向代理会覆盖客户端传入的转发地址头，避免通过伪造头绕过服务端地址判断。
- 两个完整服务器可以分别安装，但同一个管理器实例一次只挂载一个到给定的公开端口；它们不是能够安全叠加的两组插件。
- Forge 自己的 `pack.json` ABI 不假装兼容到这些源码里。第一阶段保证完整服务器源码可通过管理器托管且不丢玩法/UI。要将 Forge 包真正注入这些不同版本的运行时，需要后续逐条建立 API/协议适配和契约测试，不能通过声称“已兼容”代替实现。
- 所有变更只放在 Forge 分支的管理器控制面、配置、测试和文档中。上游游戏文件不改；两个用户仓库不改、不提 PR、不推分支。

### 明确不做

- 不把游戏玩法拆成几十个插件。
- 不直接覆盖 Forge 的 `server/`、`public/`、`shared/` 来伪装成某个用户仓库。
- 不自动把两个完整源码树合并成一个“混合玩法”；冲突文件没有共同基线时不允许任意择一。
- 不在源仓库目录中安装依赖或生成构建产物。

## 4. 实施阶段与验收

| 阶段 / 项目 | 状态 | 验收标准 |
|---|---|---|
| 只读审计两个源码树、管理器入口和保护门禁 | IMPLEMENTED | 记录四个仓库的 commit、版本、入口及不能直接复用的 ABI 边界 |
| 新建 `chatgpt` 分支并冻结配置 SHA | IMPLEMENTED | 分支从 Forge `master` 当前提交建立；配置包含两个用户仓库和固定 SHA |
| 实现配置验证、隔离安装、完整性检查 | PENDING | 非法 profile/路径被拒绝；安装只写入管理器隔离缓存；实际 checkout SHA 必须相等 |
| 实现透明 HTTP + WebSocket 代理和子进程托管 | PENDING | 首页、客户端 JS/CSS、`/healthz`、`/ws` 可经代理工作；异常退出与关闭时清理子进程 |
| 增加自动化测试与运行说明 | PENDING | 纯函数及代理头处理有测试；运行时验证脚本与文档命令一致 |
| GitHub CI/运行时实测 | PENDING | 源码检验、测试、CI 完成后才可标为 PASS；未实测前不宣称通过 |

### 最终验收清单

- [ ] 两个源仓库的 GitHub HEAD 未被修改，且本次提交只存在于 Forge 的 `chatgpt` 分支。
- [ ] `stronghold-server` 与 `stronghold-server-server-agent` 可按各自固定 SHA 独立安装。
- [ ] 运行时清单、版本、必需入口和完整 UI/游戏逻辑文件均存在。
- [ ] `server/index.js` 从隔离副本启动，原仓库无新增或修改文件。
- [ ] HTTP 与 WebSocket 代理都转发成功，转发头不能信任外部伪造值。
- [ ] `node --test test/source-runtime.test.mjs`、Forge CI、现有 overlay/manager-only 检查成功。
- [ ] 不将尚未实测的结果写成 PASS。
