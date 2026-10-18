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

## 5. 仍需所有者裁决的公共路径：初始均为 PENDING

玩法文件不在此表中：救援/复活、联防二段接力、全员离线冻结、房主浏览器 AI 代算已经转入独立功能包策略，见第 9 节和 `docs/audit/2026-10-18-feature-isolation-and-conflicts.md`。下面只保留真正需要上游公共接口取舍的候选路径。

| 路径 | 保留上游的优点 | 保留自有差异的优点 | 当前建议 |
|---|---|---|---|
| `stronghold-server:data/config.json` | 保留目标上游的 `rewards.milestones/daily` 新奖励结构 | 保留 `economy.poolCopiesOverrides.chess_char_6_11_a=4` 自有牌池数量 | 不整文件覆盖；保留上游 rewards，只迁入单个经济池键；来源缺失 rewards 是否有意删除待确认 |
| `stronghold-server:server/lobby.js` | 保留上游房间生命周期、重连/主机迁移与 Match 接口 | 保留公共匹配、实验性容量/房间能力 | 上游大厅为底，把匹配与容量单独做 adapter |
| `stronghold-server:shared/protocol.js` | 保持当前客户端、协议校验与服务端处理器一致 | 保留自定义玩法/UI 消息声明 | 以功能命名空间扩展协议，客户端和服务端成对登记 |
| `stronghold-server:server/index.js` | 保留上游启动、退出和网络初始化顺序 | 保留 Worker、监控、健康/流量统计 | 上游入口 + 可关闭的 boot/shutdown 模块 |
| `stronghold-server-server-agent:server/index.js` | 保留上游入口与依赖初始化契约 | 保留 Agent、资源缓存、运维观测能力 | 仅挂载明确需要的模块，不替换主入口 |

这些是 owner-review 清单，不代表上述每一项在文本上都已出现无法自动合并的 hunk。最终需要你决定的**真实冲突**应来自原始 Git blob audit 的 `pending[]`；同一路径发生变化本身不等于冲突，也不能用未验证的旧统计替代。

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

## 8. 审计器修正状态

第一次 Actions 审计检测到审计器按工作树字节比较文件，可能受 .gitattributes 的换行转换影响；该次文件差异数量已作废，不作为冲突决策依据。

已将来源/基线/目标文件比较改为 Git 对象库的原始 blob 字节，并新增 eol=crlf 回归测试。下一次 source-delta-audit 成功的结果才作为有效审计基线。


## 9. 2026-10-18 分类修正：玩法不再按整文件冲突裁决

本节覆盖上文第 3 节和第 5 节中将 `settle.js`、`unite.js`、agent `server/lobby.js`、agent `prep.js` 直接列为 source/upstream 高风险二选一的旧分类。它们是独立玩法或其接线，不再通过公共路径整文件覆盖进行取舍。

- 独立玩法映射见 `config/source-delta-features.json`，细化权衡见 `docs/audit/2026-10-18-feature-isolation-and-conflicts.md`。
- 可独立归属的来源模块以原始 Git blob 放到 `.forge-source-features/`；仍与上游公共状态机交织的来源文件以原始 blob 放到 `.forge-source-references/`，两者都不覆盖组合树中的上游公共路径。救援/复活尚未完成独立模块提取，见新审计文档。
- 上述路径不再生成普通的 `owner-review-required` / hunk 冲突；它们转成 `integrationPending`，表示需要管理器适配器接通。
- 这个更改没有宣称玩法已经启动。只要功能包仍是 `adapter-required`，`READY=false`。其余实际冲突仍按新的原始 blob audit 报告和所有者决定处理。

剩余的公共挂载点候选项是：`data/config.json`、stronghold-server 层的 `server/lobby.js`、`shared/protocol.js`、两个 profile 的 `server/index.js`，以及 UI/资源/网络/build/deployment 差异。具体优缺点和建议逐项列在新审计文档中。

当前有效测试/审计状态不变：此前按工作树字节得出的统计无效；原始 Git blob 审计及新隔离测试的 Actions 结果尚待核实，不能标为 PASS。
