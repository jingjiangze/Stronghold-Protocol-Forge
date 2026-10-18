# 完整服务器源码挂载（Source Runtime）

这里新增的是管理器运行时配置，不是把游戏玩法转换成 Forge 工坊包。

## 快速开始

在 Forge 仓库的管理器环境中，使用 Node.js 22 或 24 与 Git：

1. 查看支持的完整服务器配置：

   `node tools/source-runtime.mjs list`

2. 将选定的完整服务器安装到用户目录中的隔离缓存：

   `node tools/source-runtime.mjs install stronghold-server`

   或安装含真人布阵学习链路的版本：

   `node tools/source-runtime.mjs install stronghold-server-server-agent`

3. 检查固定版本、入口、游戏 UI 文件与依赖是否齐全：

   `node tools/source-runtime.mjs verify stronghold-server`

4. 通过管理器托管所选游戏：

   `node tools/source-runtime.mjs serve stronghold-server --port 3000 --host 127.0.0.1`

   要允许局域网设备访问时，才将 host 改为 `0.0.0.0`。默认只监听本机。Ctrl+C 会停止代理和游戏子进程。

外部代理或 Cloudflare Tunnel 应指向管理器的公开端口；游戏客户端的 HTTP 路由与 WebSocket 路由保持原路径。管理器状态端点为 `/_manager/source-runtime/healthz`。

## 源码保护与版本固定

- 配置文件固定仓库、分支名、完整 40 位 commit SHA、应用版本和必需文件清单。
- 下载的运行时副本位于 `%USERPROFILE%\.stronghold-protocol-forge\source-runtimes\`（Windows）或 `~/.stronghold-protocol-forge/source-runtimes/`（类 Unix 系统）。可通过绝对路径环境变量 `SP_SOURCE_RUNTIME_HOME` 自定义，但目标必须位于 Git 工作树之外。
- 安装过程只在隔离副本内执行 Git checkout 与 `npm ci --omit=dev`，包括生成该副本自己的 `public/vendor/`。不会在两个源仓库或 Forge 工作树里执行安装、写入、格式化或补丁。
- 服务入口是源仓库原本的 `server/index.js`。管理器代理 HTTP 和 WebSocket，并覆盖转发客户端地址头，避免把外部伪造的 `X-Forwarded-For` 当成可信地址。
- 两个源仓库都是完整服务器而不是可叠加的 mod。每次 serve 只挂载所选的一份完整运行时；不能不经逐文件冲突裁决就把两份完整源码树覆盖到一起。

## 保留范围和边界

本方案保留所选仓库的源码玩法、房间/协议逻辑、客户端 HTML/CSS/JS 与路由，不把它们转换为单个或多个 mod 包，也不改原仓库。Forge 现有 pack ABI 并不会因这层透明托管而自动出现在用户仓库里；将 Forge mod 真正注入这些不同源码版本需要独立的 ABI 适配与契约测试，不能假定已完成。

源码仓库并不一定包含全部官方美术、音效和字体文件。管理器不伪造这些文件，也不会修改资产 URL；运行时仍使用该版本现有的资产清单和来源配置。如果配置的远端资产不可达，需要单独恢复对应资产载荷到隔离运行时中，而不是向源仓库写入文件。

## 常见问题

- **提示 SHA 不匹配**：配置锁定的是已审计提交。如果源分支后来前进，管理器仍会检出固定 SHA；只有该提交不可取得或不符合版本/文件清单时才会失败。更新 SHA 应作为单独的审计提交。
- **提示 public/vendor 为空**：生产依赖安装或 vendor 生成不完整；管理器会拒绝启动，以免提供缺少客户端核心依赖的页面。
- **游戏退出**：管理器会记录退出状态、关闭代理并退出；重启 serve 命令即可重新启动。管理器只在运行期间提供 health 端点。
- **要同时挂载两份源码**：它们各自都占用完整首页和 /ws 游戏协议。可以用不同端口分别运行，但不会将其代码自动合并进同一个对局运行时。
