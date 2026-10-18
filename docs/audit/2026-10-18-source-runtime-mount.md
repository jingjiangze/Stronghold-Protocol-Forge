# 审计与执行方案：把服务器差异外置为管理器挂载层

日期：2026-10-18；分支：chatgpt。
范围：只改 jingjiangze/Stronghold-Protocol-Forge，不向两个来源仓库或上游游戏仓提交。

## 1. 固定审计基线

| 对象 | SHA / 版本 | 状态 |
|---|---|---|
| Forge 起点 | 3dd6ba602fd96a5002f142d7387dcef0a472f8fb | BASELINE |
| 上游共同基线 | upstream v0.2.5，cf7a9400270d5aa79b2e601e405dab782e25f120 | BASELINE |
| 目标上游 | d905c1464f762a03d236c7ad6bc3ba31a74f4494 | BASELINE |
| stronghold-server | 48f8cff8277060a4da489f4f19658fcd05ebd145，v0.2.5 | BASELINE |
| server-agent | d16ce8bd158aee31b74ac34635a585a7bdb5fe05，v0.2.6 | BASELINE |

## 2. 文件树差异统计

| 来源 | 内容相同 | 同路径不同 | 来源独有 | 基线独有 |
|---|---:|---:|---:|---:|
| stronghold-server | 1124 | 261 | 391 | 10 |
| server-agent | 1291 | 104 | 46 | 0 |

文件数并非冲突数。新增文件可独立挂载；同路径修改做三方合并；语义高风险路径或同段重叠才需要人工裁决。

## 3. 功能差异

### stronghold-server

- 对局/协作：救援复活结算、联防二段接力、公共匹配队列、实验性房间容量。触点包含 server/lobby.js、server/match、shared/protocol.js 和玩家容量设置，客户端及服务器协议必须成对挂载。
- UI：大厅公告、伤害统计、匹配、皮肤/干员预设、实验开关、素材/模型回退、服务器状态与遥测。新增模块可按增量加入；现有屏幕、CSS、main.js 的改动需逐块合并。
- 网络/资源：素材地址跳转、内容哈希缓存、镜像探测、WebSocket 压缩、流量/健康监测和上游监测，需核对客户端 URL、服务端路由及错误回退。
- 部署：Stardust 集群、反向代理、ModelScope sidecar 和运维工具约 146 个独有 deploy 文件，单列 deployment 组，仅在目标环境需要时挂载。
- 数值/资源：data/config.json 的 Boss 血量规则不同于上游；data/assets.json 是生成清单，不能盲目整份覆盖。

### server-agent

- 真人布阵学习：lineupLibrary、outbox、publish、sync 及迁移工具，含按模式/难度分组的学习库和远端写回。
- 房主浏览器代算 AI 布阵：客户端 Worker、准备阶段服务端接线、超时/掉线回退，必须作为一个完整功能切片挂载。
- 全员离线冻结：让所有真人暂时离开时对局暂停，需与阶段计时、联防和重连流程共同验收。
- 素材和观测：素材哈希缓存、asset jump、流量统计、镜像探测和 upstream watch；server/index.js 公共初始化片段必须跟新版主流程协调。

## 4. 执行架构

不把完整来源仓库作为游戏运行时，也不将玩法重写成 pack.json 插件。source-delta 层固定共同基线、目标上游 SHA 和两个来源 SHA；克隆只读快照，在隔离输出树中以较新上游为基础叠加增量。

1. 来源新增路径：上游没有同名文件时原样挂载；两边独立新增且内容不同则生成冲突。
2. 共同路径：若目标仍等于基线，挂载来源文件；若上游已等于来源，视为已包含；否则三方合并，自动组合非重叠修改。
3. 重叠 hunk：生成稳定 ID，在 config/source-delta-decisions.json 选择 source/upstream；未选时保留上游版本并标 PENDING。
4. 高风险路径预先要求所有者确认。未裁决时不产出 READY 构建。
5. 所有缓存/输出写在来源仓库与 Forge 工作树之外，绝不回写源仓库。

## 5. 高风险裁决：初始均为 PENDING

| 路径 | 选择 source 的优点/代价 | 选择 upstream 的优点/代价 |
|---|---|---|
| stronghold-server:data/config.json | 保留 Boss 血量/难度规则；可能丢上游新数值与经济表 | 跟进上游数据；失去自定义血量规则 |
| stronghold-server:server/lobby.js | 保留匹配/实验房间；新版大厅接口可能不兼容 | 保留新版状态机；自定义匹配可能缺接线 |
| stronghold-server:shared/protocol.js | 保留自定义消息；客户端/服务端必须成对运行 | 更容易跟上游；自定义功能消失 |
| stronghold-server:server/match/match/settle.js | 保留复活救援；可能覆盖上游结算修复 | 保留上游结算；自定义复活可能消失 |
| stronghold-server:server/match/unite.js | 保留联防二段接力；可能与新版协作流程冲突 | 跟进上游联防；丢二段接力 |
| stronghold-server:server/index.js | 保留 Worker/监控；启动与关闭风险高 | 保留新版主入口；额外监控需重新挂载 |
| server-agent:server/lobby.js | 保留代算/冻结接线；需和来源一大厅一起验证 | 保留上游大厅；Agent 功能可能失效 |
| server-agent:server/match/match/prep.js | 保留 AI 代算；必须同时挂载 Worker 和回退 | 跟进新版准备阶段；代算需重新适配 |
| server-agent:server/index.js | 保留素材/流量/Agent 接线；初始化顺序风险 | 保留新版入口；自定义接线需重新挂载 |

这些是预设高风险路径，不表示已确认每个都有冲突。真实 audit 会进一步列出无法自动合并的文件/hunk。

## 6. 优缺点

优点：上游继续作为游戏本体；来源仓库不改；新增文件和非重叠修改可自动挂载；后续更新管理器的 SHA/选择即可重现组合；冲突可追溯。

代价：文本三方合并不证明语义兼容；接口/生命周期大重构仍可能需要适配；生成清单与 Git 未跟踪资产要单独准备；冲突未裁决时 READY 被阻止。

## 7. 状态

| 项目 | 状态 |
|---|---|
| 固定共同基线、目标上游和来源 SHA | IMPLEMENTED |
| 隔离缓存、差异分组、三方合并器 | IMPLEMENTED |
| 高风险裁决文件、稳定 hunk ID 和 READY 门禁 | IMPLEMENTED |
| 单元测试代码 | IMPLEMENTED；结果待 Actions |
| 真实来源快照 audit 报告 | PENDING |
| 所有者裁决与最终游戏回归 | PENDING |

BASELINE=确认输入；IMPLEMENTED=代码/文档已提交；PASS=实测通过；PENDING=等待实测或所有者裁决。

## 8. 实际快照审计结果（GitHub Actions run 39112551942）

状态：**PASS（审计任务成功执行）**；这不代表组合构建已 READY。报告 artifact 名称为 source-delta-audit，可从该次 Actions 运行页面获取。

| 来源 | 差异路径数 | 默认组之外 | 已包含在目标上游 | 新增挂载 | 等待裁决 |
|---|---:|---:|---:|---:|---:|
| stronghold-server | 1395 | 737 | 652 | 0 | 6 |
| server-agent | 150 | 66 | 0 | 23 | 61 |
| 合计 | 1545 | 803 | 652 | 23 | 67 |

本次默认只组合 runtime/build/operations/deployment。803 个路径属于 docs/tests/automation/metadata 等被排除的组，并没有写入生成运行树；它们仍保留在差异报告中。上游已包含的 652 个差异不再覆盖。23 个未被上游包含的新增文件已作为来源增量挂载。该快照下自动 clean merge 数为 0：这不是“零冲突”，而是现有差异要么已被上游吸收、是新文件、要么需要明确裁决。

### 已发现的裁决类型

- stronghold-server 的 6 项：data/config.json 的 Boss 血量/数值策略、server/index.js 启动/Worker/监控、server/lobby.js 匹配/实验房间、server/match/match/settle.js 复活结算、server/match/unite.js 联防接力、shared/protocol.js 自定义协议。全部保持 PENDING。
- server-agent 的 61 项：上游 0.3.1 线已删除或重组了多个 v0.2.5 基线路径，而 agent 源码仍修改旧路径。报告代表路径包括 Dockerfile、package.json/package-lock.json、public/js/main.js、public/js/render/*、public/js/screens/*、server/http/*、server/match/Match.js、server/match/match/*、shared/constants.js、shared/protocol.js 和工具脚本；同时 server/index.js、server/lobby.js、server/match/match/prep.js 是预先登记的高风险路径。

### 这 61 项不能按普通文本冲突处理

目标上游删除/拆分了旧路径时，“选择 source”意味着将旧版本完整文件恢复到旧路径；它不等于把玩法安全移植到上游的新模块。对希望保留的功能，下一步应在管理器差异层里建立明确的新挂载点/适配映射并测试，而不是直接恢复所有旧文件。选择 upstream 则表示放弃这一来源路径的增量。当前工具保持它们 PENDING，并阻止 READY，避免悄悄生成不完整或重复执行的游戏代码。

### 验证结果

- source-overlay 单元测试：PASS（7 项）。
- 固定 SHA 的两份来源克隆和上游快照审计：PASS（任务成功，报告已上传 artifact）。
- 组合是否可直接运行：PENDING（67 项待裁决；尚未达到 READY）。
- Forge 全量 CI：TypeScript 检查仍报出本次未修改的 shared/formProjection.js 和 shared/morph.js 类型错误；因此不能标记整体 CI PASS。
