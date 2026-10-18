# MOD-MANAGER.md — 模组管理器（0.3.1）

三种入口，一条装载链。

| 入口 | 用途 |
|---|---|
| `GET /mod` | 同源页面：手动上传 zip、从 https 地址抓取、看已装列表 |
| `node tools/mod.mjs …` | 命令行：`import` / `check` / `pack` / `list` / `watch` |
| `mod-inbox/` 目录 | 把 zip 丢进去即安装（`SP_MODS=off` 可关） |

## 1. 它不做第二套装载

导入只有两条去向，都是上游 0.3.1 自己的代码：

```
zip ──┬─ 有 pack.json   → server/plugins/forgeImport.js  （Forge 包 → 普通插件目录）
      ├─ 有 plugin.json → server/plugins/install.js     （插件 zip → 校验 → 暂存 → 改名）
      └─ 都没有         → 拒绝，写 .reason.txt
```

装完仍然走 `plugins[] → contentSet → cs → room.setPlugins → consent → contentReady`。
**导入 ≠ 启用**：装进来的插件不会自动进任何房间，也不会进 `plugins/config.json` 的 `default`。

## 2. 页面 `/mod`

- **谁能进**：与 `/studio/` 同一道门（`server/studio/gate.js`）——本机或局域网、Host 是本地名；其他来源拿到 404。
  `SP_STUDIO=off` 会连 `/mod` 一起关掉。
- **读**（页面、`/mod/status.json`）不需要钥匙。
- **写**（上传、抓取）需要业主钥匙：`plugins/.studio-key`，请求头 `X-SP-Mod`（也接受 `X-SP-Studio` 和 `?key=`）。
  页面把它存在浏览器 localStorage，不会写回服务器。此外还要求同源（`Sec-Fetch-Site` / `Origin`）。
- **上传**：`POST /mod/upload`，请求体就是 zip 原始字节。同名插件已存在时加 `?force=1` 覆盖。
- **抓取**：`POST /mod/fetch`，JSON `{ url, sha256?, force? }`。只接受公开 https（上游 `fetchHttps` 的地址规则）；
  给了 `sha256` 就校验，不给就按包内清单判定类型。

页面不依赖任何外部资源，内联脚本 + 内联样式，CSP 友好。

## 3. 命令行

```
node tools/mod.mjs import <pack-dir | zip> [--force] [--dry-run]
node tools/mod.mjs check  <pack-dir | zip>          # 只出报告，不写文件
node tools/mod.mjs pack   <pack-dir> [-o out.zip]   # 确定性 zip（文件按名排序、统一时间戳）
node tools/mod.mjs list                             # plugins/ 下已安装的
node tools/mod.mjs watch  [inbox-dir]               # 常驻监听
```

`pack` 用它把作者的包目录打成 zip：同一个目录两次打包**字节相同**，便于比对与分发。

## 4. 收件目录

默认 `mod-inbox/`（服务器根目录下）。行为：

1. 文件大小连续两次检查不变才算写完（拷贝到一半不会被读）；
2. 导入成功 → 移到 `_done/`；
3. 被拒 → 移到 `_failed/`，旁边写 `<名字>.reason.txt` 说明原因；
4. **不删除任何东西**。

## 5. 报告

Forge 包的导入是"尽力而为"的（上游策略）：它能导的写进插件，导不了的逐条列在报告里（`PLUGIN_FORGE_*` 代码 +
中英双语原因）。报告同时是 `check` 的输出、`/mod/upload` 的 JSON 字段（`markdown` + `issues`）和 CLI 的 stdout。
**"检查通过"只代表没有硬错误，不代表玩法全在**——这句在报告里也是原文。

## 6. 与模式模块的关系

`server/mota/`（见 [MOTA-MODE.md](MOTA-MODE.md)）是引擎内的第一方模式模块，**不走**这里的导入通道。
模组管理器只处理 `pack.json` / `plugin.json` 两类包。

## 7. 环境

- 上游 `forgeImport` 在 Windows 上创建符号链接会 `EPERM`（需要开发者模式或管理员）。本仓库补了一段回退：
  符号链接失败就递归复制（校验视图是只读的，等价）。这是 3 行改动，位于 `server/plugins/forgeImport.js`
  `openValidationView` 的 `take()`。
- `kits/`（技能脚本）需要 `acorn` 才能解析；未安装 `node_modules` 时这一项会出现在"没有导入的玩法"里。
