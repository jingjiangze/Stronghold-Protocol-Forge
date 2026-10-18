# 独立玩法隔离与其余差异裁决清单

日期：2026-10-18；分支：`chatgpt`。
审计输入仍固定在 `config/source-delta-profiles.json` 中声明的共同基线、目标上游和两个来源 SHA。只改 Forge 管理器；不改写 `sganggs/Stronghold-Protocol`、`jingjiangze/stronghold-server` 或 `jingjiangze/stronghold-server-server-agent`。

## 1. 先纠正分类原则

**救援/复活、联防二段接力、全员离线冻结、房主浏览器 AI 代算属于独立玩法/功能，不该用“同一文件整份选 source 或 upstream”来裁定玩法归属。**

但这不等于其当前实现已天然与上游无冲突。审阅固定源码发现，若干功能仍与公共状态机/入口写在相同文件里：

- 联防二段接力的规则/阶段模块是 `server/match/unite.js` 和 `server/match/match/unitePhase.js`；结果/奖励归因交织在共享的 `server/match/match/settle.js`，目前只作为 reference 保存。
- 冻结模块是 `server/match/match/frozen.js`；agent 版本 `server/lobby.js` 仅作共享生命周期 reference。
- AI 代算独立模块包括浏览器调度与 Worker、共享模拟评分、服务端 `MatchRehearsal`；`public/js/main.js`、`prep.js`、`lobby.js`、`Match.js`、`server/index.js` 仅作为当前挂载点 reference。
- 来源 `server/match/match/combat.js` 明确要求 synthetic 结果不能冒充真实救援资格；具体复活不是单一独立模块，而是散布在 `server/sim/content/items/battle.js`（`reviveNow`、死亡/立即免费再部署顺序）、`bands/battle.js`（埃芒加德）、`bonds/addon/battle.js`（不屈）及 Swire2、乌尔比安等干员模块，底层时序在 `server/sim/Battle.js`。这些大文件还承载其他装备/干员机制，不能整份作为复活插件覆盖上游。当前都只放进 reference 区，需再把复活规则提取为窄接口的独立管理器模块。

因此执行三类隔离：

1. **独立模块层**：将可独立归属的来源 Git blob 原样保存到 `.forge-source-features/<feature-id>/<profile>/<original-path>`。不修改来源仓库，不改写 blob 字节，也不把同路径文件整份覆盖进上游主树。
2. **共享路径参考层**：把依然承载两边逻辑的完整来源文件原样保存到 `.forge-source-references/<feature-id>/<profile>/<original-path>`。这些文件只是提取适配器时对照的参考，不会被当作独立可执行模块。
3. **适配挂载点层**：把状态机、生命周期、协议、UI/Worker 的公共入口单独记录。当前 manifest 将四个功能标记为 `adapter-required`；管理器尚未证明适配器已经接通，所以即使没有路径级冲突，`READY` 仍然必须是 false。

这是一种“独立源码 + 管理器适配器”的边界，不是把代码放进隔离目录就假装它已运行。已通过固定来源 Git tree 确认 AI 代算的浏览器与模拟模块路径，包括 `public/js/battle/rehearsal.js`、`public/js/battle/rehearsalWorker.js`、`server/sim/rehearsal.js` 和 `server/match/match/rehearsal.js`；这些已作为独立模块纳入清单。`public/js/main.js`、`server/match/Match.js`、`prep.js`、`lobby.js` 与 `server/index.js` 仍是接线参考。路径已确认，但与当前上游架构的接口适配和双端回归仍 PENDING。

## 2. 独立功能包：不再参与整文件二选一

| 功能包 | 当前隔离的来源文件 | 管理器需挂载的公共接口 | 当前结论 |
|---|---|---|---|
| 救援/复活 | 目前没有可独立加载的来源模块 | 只读参考：`combat.js`、底层 `Battle.js`、items/bands/bonds registries 和 Gravel/Swire2/Ulpianus kits | 实现横跨共享模块；需要从死亡/立即免费再部署钩子抽出窄接口，不可将任一混合文件整体作为玩法模块 |
| 联防二段接力 | `.forge-source-features/`：`server/match/unite.js`、`server/match/match/unitePhase.js` | `.forge-source-references/`：共享的 `server/match/match/settle.js`；并需成对接协议字段/结果 view | 玩法规则/阶段模块独立；结算奖励、结果视图和客户端消息仍需适配 |
| 全员离线冻结对局 | `.forge-source-features/`：`server/match/match/frozen.js` | `.forge-source-references/`：agent 层的 `server/lobby.js`；另需 `MatchPause`、重连窗口和终止流程兼容 | 冻结模块独立；大厅接线独立适配，不能用 agent 版大厅整文件覆盖上游 |
| 房主浏览器 AI 代算 | `.forge-source-features/`：`public/js/battle/rehearsal.js`、`public/js/battle/rehearsalWorker.js`、`server/match/match/rehearsal.js`、`server/sim/rehearsal.js` | `.forge-source-references/`：`public/js/main.js`、`server/match/Match.js`、`server/match/match/prep.js`、`server/lobby.js`、`server/index.js`；并需校验 `shared/protocol.js` | 客户端与服务端模块已纳入隔离清单；与目标上游新插件/Match 接口的适配、主机切换及超时回退回归仍 PENDING |

**优点：** 自定义玩法的源码和版本身份保留；上游对同一公共文件的修复不会直接被来源整文件覆盖；每个玩法可以独立启用/停用和回归。

**代价：** 公共挂载点仍需适配，不是零成本的热加载。任何涉及 Match 阶段、结算、重连、协议的功能，都必须验证接口和时序。未完成适配前这些源码仅被隔离保留，不能宣称已进入运行时。

## 3. 仍需你裁决的公共挂载点与非玩法差异

以下是需要继续审阅的**候选差异面**。除固定配置中列出的 owner-review 项外，其他文件是否形成真实文本/hunk 冲突，要以修正后的原始 Git blob audit 报告为准；“路径被修改”不等于“实际冲突”。

### A. `data/config.json` — 奖励表和经济池覆写

对固定的来源快照、共同基线和目标上游 JSON 做了逐键比较后，**Boss 血量缩放规则不是当前差异**：来源与目标上游 9 个模式的 `bossHpScale` 相同。此前的说明有误，已修正配置裁决文件。

本次可精确确认的叶子差异只有三项：
- 来源新增 `economy.poolCopiesOverrides.chess_char_6_11_a = 4`；
- 目标上游有 `rewards.milestones`，来源快照没有顶层 `rewards`；
- 目标上游有 `rewards.daily`，来源快照同样没有。

- **上游方案的优点**：保留目标上游较新的里程碑奖励与每日奖励结构，和目标版本的数据读取方式对齐。
- **你这边方案的优点**：保留 `chess_char_6_11_a` 的牌池数量覆写为 4，可维持你希望的经济/卡池平衡。
- **代价与风险**：整份选择来源 JSON 会连目标上游的 `rewards.milestones/daily` 一起删掉；整份选择上游则会漏掉自有的牌池覆写。现有文件级选择不适合这个差异。
- **建议组合**：保留目标上游 `rewards`，只把 `economy.poolCopiesOverrides.chess_char_6_11_a=4` 迁入组合配置；对来源缺失 `rewards` 的删除意图留给你确认，不自动删除上游奖励字段。
- **当前状态**：`PENDING`，等待你确认奖励删除是不是有意为之；其余差异可按上面的定向合并处理，不应整文件二选一。

### B. `server/lobby.js`（stronghold-server profile）— 匹配、实验房间、插件房间生命周期

固定来源文件约 1,531 行，目标上游版本约 1,885 行；这不是单纯多几行的差异，而是两种功能集合不同。

- **上游方案的优点**：把插件/内容集生命周期做成正式房间协议，包括 `room.setPlugins`、`room.setMode`、`room.consent`、`room.contentReady`；还加入 `serial/queueEvent`、房间内容代际跟踪、可信运行时和插件变更流程，能防止异步断线/重连/内容变更与 Match 状态交错。
- **你这边方案的优点**：具有 `queue.join/cancel/accept` 公共匹配队列、`room.setExperimental`、实验房间容量、`playerCapacityVersion`/ `matchmakingVersion` 握手、按 IP 限制房间/对局数，以及联防实验容量相关控制。这些是你现有玩家体验和扩容行为，不能因为上游换架构就直接丢掉。
- **代价与风险**：整份选来源版会丢目标上游插件内容集/同意校验与异步事件队列；整份选上游又会丢自有匹配队列/实验容量规则。两边的消息处理与房间状态表也不对称。
- **建议组合**：以目标上游 Lobby 为唯一房间状态机；匹配队列、实验容量、版本握手作为 Forge adapter 独立接入。进入高容量房间前仍要校验客户端能力；插件内容集与内容 hash/consent 不能被绕过。使用统一的串行事件入口处理 disconnect、host change、reconnect 和 room close。
- **当前状态**：`PENDING` 作为高风险公共挂载点，未要求选整份文件；最终需要你裁决的是匹配/容量政策，而不是上游房间引擎是否保留。

### C. `shared/protocol.js` — 双端消息与数据校验

- **上游方案的优点**：除常规消息字段校验外，当前版本支持插件模式的 `room.setPlugins`、`room.setMode`、`room.consent`、`room.contentReady`，以及 skin selection / operator potential 等更丰富的配置校验。它与上游 Lobby、客户端和 content hash 流程同步。
- **你这边方案的优点**：协议定义了 `queue.join/cancel/accept`、`room.setExperimental`，以及 hello 握手中的 `matchmakingVersion`、`playerCapacityVersion`；还有服务负载状态 `SERVER_LOAD_STATES`、`normalizeServerLoad`、`normalizeLoadDetails`，便于客户端感知服务端负载并兼容实验容量。
- **代价与风险**：不是“只添加几个消息字符串”即可。上游有 source 版本没有的插件/模式/内容确认消息；source 有上游没有的匹配队列与实验容量消息/字段。若只迁服务端消息定义，客户端可能不发；若只迁客户端，服务端校验会拒绝；版本握手或参数边界不同还可能导致旧客户端无法加入高容量房间。
- **建议组合**：以目标上游 schema 为主；把自有功能消息作为单独扩展表注册，并由 Forge manifest 成对声明 client handler、server handler、版本/能力协商和负载字段。对每条扩展消息加未知版本、缺字段、越权操作和旧客户端测试，不替换整个协议表。
- **当前状态**：`PENDING`；扩展消息的客户端与服务端成对接线必须和相应 feature adapter 一起验收。

### D. `server/index.js`（两个来源 profile 各有差异）— 进程启动与运行时扩展

固定来源的 `stronghold-server/server/index.js` 使用 `CombatWorkerPool` 和独立 trial/rehearsal worker pool，提供 server-load/health metrics、WebSocket compression、asset-jump、announcement source、OAuth route，以及当前 modBridge/workshop server hooks。目标上游则引入正式 plugin registry、内容集 hash/consent、每个内容集的 match host（process/worker）、room sets、trusted runtime、plugin studio、CSP、traffic counter 与 asset index/views。

- **上游方案的优点**：这是当前插件/内容集隔离架构的生命周期根；内容集的运行上下文和 Match host 分离，插件的崩溃/阻塞可局限在对应 host；CSP、流量统计、asset index、trusted runtime 和 studio 都与新插件系统对齐。
- **你这边方案的优点**：固定 worker 池、单独 rehearsal pool、负载诊断、WebSocket 压缩、素材跳转、公告/OAuth 路由和现有 ModBridge 能直接解决你实际运行中的计算、资源、管理接线问题。
- **代价与风险**：来源整份入口会缺失上游的 content-set / per-room host / trusted-plugin 生命周期；上游整份入口会丢现有 worker-pool 开关、负载诊断、asset jump 和部分服务接线。两个启动流程的依赖顺序、关闭流程和回退行为均不同。
- **建议组合**：保留目标上游 `startServer`、plugin/content-set/host 架构；由 Forge 生成独立注册器把自有能力接成可关闭的 boot/shutdown adapters。先接通可观测性和 asset-jump，再按 feature profile 挂载 worker pool；不要将旧 ModBridge 当作新的主入口。服务启动时适配失败应显式禁用功能或让启动失败，不能静默半加载。
- **当前状态**：`PENDING`；属于公共启动挂载点的架构取舍，不应整份选来源文件。

### E. `public/**` — 客户端大厅 UI、公告、伤害面板、皮肤/干员预设、素材加载

- **上游方案的优点**：DOM/状态/路由与上游最新 UI 一致，减少对旧 CSS、页面结构和事件委托的耦合。
- **你这边方案的优点**：保留现有产品功能和交互，尤其是公告入口、战斗伤害统计、自定义外观与素材回退。
- **代价与风险**：整份 `main.js`、页面或公共样式覆盖会把两边的独立 UI 功能一起丢掉；同选择器和 DOM id 也可能互相影响。
- **建议**：新 UI 文件按新增模块挂载；同路径 UI 只做最小的组件/事件适配，优先挂到稳定 DOM/事件接口。每个页面分别做截图和交互回归，不做 `public/` 整目录二选一。
- **当前状态**：有变更面已分类；逐 hunk 结论以修正后的实际 audit 为准。

### F. 素材清单/寻址/缓存（如 `data/assets.json`、asset jump、内容哈希、镜像探测）

- **上游方案的优点**：清单格式和上游构建/加载器保持一致，减少资产缺失、哈希失配和启动时的兼容问题。
- **你这边方案的优点**：保留自有 CDN 跳转、镜像测试、缓存与回退能力，降低单一素材源故障的影响。
- **代价与风险**：生成的整份素材清单不能从旧分支直接覆盖；代码里写死的镜像地址也会造成运维与版本耦合。Git 未跟踪的大图/音频/字体不在这次 Git blob diff 的覆盖范围内。
- **建议**：先对目标上游运行正式清单生成器，再只叠加经验证的素材寻址逻辑；逐个检查资源 URL、hash、404/超时回退和缓存失效。

### G. WebSocket/网络/遥测（如 `server/net.js`、压缩、流量/健康监测）

- **上游方案的优点**：维持握手、鉴权、限额、心跳和消息格式的单一事实来源。
- **你这边方案的优点**：保留压缩、流量统计和健康检测，帮助定位高并发、慢客户端和素材流量问题。
- **代价与风险**：更改压缩/帧编码或发送语义可能造成旧客户端无法连接；观测代码若阻塞事件循环会直接影响对局。
- **建议**：先维持上游协议与握手路径；压缩/观测走可关闭的 adapter，加入旧客户端兼容、慢连接、背压、断线重连和消息丢弃测试。

### H. build/dependencies/package metadata

- **上游方案的优点**：新版本依赖、脚本和构建约定更容易匹配目标上游，减少锁文件漂移。
- **你这边方案的优点**：保留自己的构建、资源检查、发布和诊断自动化。
- **代价与风险**：整个 `package.json` 或锁文件覆盖容易丢脚本/依赖；反向整份覆盖又可能丢上游新增依赖。
- **建议**：分别对齐运行时依赖、开发依赖、脚本、lockfile；先生成最小合并，再从干净目录执行安装、测试、打包验证。

### I. 部署/运维（Stardust 集群、反代、ModelScope sidecar 等）

- **上游方案的优点**：默认配置更通用、部署面更小，不强迫普通单机用户依赖专用环境。
- **你这边方案的优点**：保留你实际使用的集群、反代和自动监测部署工具。
- **代价与风险**：专用部署文件不是所有玩家都需要；把它们放进默认运行组合会扩大依赖面。
- **建议**：只进入 `deployment` 组，由部署 profile 显式选择；不把专用 YAML、sidecar 变量和运维脚本强行合进游戏核心。

### J. 来源删除的上游文件（共同基线里存在、来源层已删除的路径）

- **上游方案的优点**：新代码与测试仍可能依赖这些文件；保留它们更利于上游后续同步。
- **你这边方案的优点**：来源分支可能已完成替代/清理，删除是有意的。
- **代价与风险**：不能因为来源分支没有文件就自动删除目标上游里的同路径新实现。
- **建议**：确认引用方、构建入口和替代实现后再决定；默认保留上游并把删除作为可审计决策，不自动删。

## 4. 当前决策顺序

1. 独立玩法源先进入隔离区，不对公共文件做整份 source/upstream 选择。
2. 挂载点保持上游基线，逐个用管理器适配器挂载玩法；适配器完成后再把 `activationStatus` 从 `adapter-required` 改为 `ready`，并提供匹配测试证据。
3. 先审 `data/config.json`、`server/lobby.js`、`shared/protocol.js`、两个 `server/index.js` 和客户端 UI/资源链。
4. 仅对修正后审计报告真正列出的重叠 hunk 要求你选 `source/upstream`；非重叠代码自动合并。
5. 最后验证服务器启动、单人完整对局、联机加入/离开/重连、复活、两段联防、冻结/恢复、AI 代算超时/掉线回退、旧客户端协议、资源 404 回退与打包结果。

## 5. 状态表

| 项目 | 状态 |
|---|---|
| 独立玩法 bundle manifest 和隔离策略 | IMPLEMENTED |
| 来源 blob 原样暂存、上游公共文件不被整份覆盖 | IMPLEMENTED；以新隔离回归测试验证 |
| 四类功能的运行时适配器 | PENDING |
| 浏览器端 AI Worker 路径（来源固定 Git tree） | PASS：已确认 `public/js/battle/rehearsalWorker.js` 等模块并纳入 manifest |
| 原始 Git tree/blob 下的完整来源快照 audit | PENDING：先前 Actions 流程测试通过，但发现 profile 源索引与 pinned tree 结果不一致；已将索引改为 `git ls-tree`，需以新一轮 artifact 确认 |
| 其余真实冲突/hunk 的最终裁决 | PENDING |
| 上游 + 功能适配器完整游戏回归 | PENDING |

`BASELINE` = 固定审计输入；`IMPLEMENTED` = 已提交代码/文档；`PASS` = 有可核对的实测结果；`PENDING` = 尚未完成/尚未证明。不可将 `IMPLEMENTED` 当成 `PASS`。

## 6. 补充审计规则：玩法差异、真实冲突和混合挂载点分开记账

本次按你的边界再次固定规则：**救援/复活、联防二段接力、冻结/恢复、房主 AI 代算本身不进入上游/来源的玩法二选一；每个玩法由独立功能包归属。** 同一路径有改动并不意味着玩法与上游冲突。共享协议、房间生命周期、Match、启动入口只属于挂载接口，不得用整文件 source/upstream 选择来裁定玩法。

修正后的报告把三类事项分开：

| 报告类别 | 含义 | 是否称为玩法冲突 | 处理方式 |
|---|---|---|---|
| pending 中的 three-way-hunk、add-add、delete-modified、modify-deleted、binary-conflict 等 | 固定 Git blob 上真正无法自动合成的公共代码差异 | 否；若 hunk 明确是玩法接线，转由对应功能适配器处理 | 只针对真实公共残差逐项审阅，不能用整文件覆盖 |
| owner-review-required | 需要你决定的公共挂载策略，不一定存在文本重叠 | 否 | 按下方的上游/来源优劣选择接口保留策略，不默认替你选 |
| deferredMixedPaths | 某个功能引用文件同时包含玩法接线与公共功能，整个来源文件只保存到 reference 区；其非玩法残差仍待拆分 | 不把它误记成玩法冲突，也不把未处理差异算作已解决 | 继续逐项抽取/合并文件中的非玩法改动；上游文件留在组合树 |

### 玩法独立边界（执行规则）

- **救援/复活**：其行为散布在战斗死亡/重新部署时序、道具、羁绊和干员规则中。现阶段来源快照只放在 reference 区供管理器提取，不声称已拆出可运行的独立实现。下一步是让 Forge adapter 以窄接口连接这些规则，保留资格判断、优先级、费用/SP、落点与部署事件语义。
- **联防二段接力**：server/match/unite.js 和 server/match/match/unitePhase.js 属于独立玩法模块；settle.js 等公共结算只作 reference。公共结算与结果 view 保持目标上游主干，由联防 adapter 注册自己的阶段和结果。
- **冻结/恢复**：server/match/match/frozen.js 属于独立功能；来源 server/lobby.js 不作为替代大厅，而是生命周期接线参考。Forge adapter 把冻结和恢复接到上游房间生命周期，并测试断线重连、房间关闭与阶段计时。
- **房主浏览器 AI 代算**：浏览器调度、Worker、模拟评分和服务端 rehearsal 模块单独存放；main.js、prep.js、Match.js、lobby.js、server/index.js 是挂载参考。客户端 Worker 协议、房主迁移、超时/掉线回退和旧浏览器兼容必须一并测试。

### 其他公共差异：优劣和建议汇总

以下是公共接口/非玩法差异的审阅表；它们不是说整个路径存在文本冲突。实际冲突数及 hunk ID 只以最新 source-delta-audit artifact 为准。初始决策文件为空，未代你选边。

| 项目 | 上游保留的优点 | 你这边保留的优点 | 建议策略 |
|---|---|---|---|
| stronghold-server:data/config.json 奖励/经济池 | 保留新版本 rewards.milestones/daily 和数据读取契约 | 保留 economy.poolCopiesOverrides.chess_char_6_11_a=4 | 保留上游奖励树，只选择性注入单个牌池键；来源缺失 rewards 是否有意为之仍待你定 |
| stronghold-server:server/lobby.js | 新插件内容集、consent/contentReady、串行事件和重连/关闭生命周期完整 | 公共匹配队列、实验模式/容量、容量与匹配版本握手、IP 限额 | 上游作为唯一房间状态机；匹配和容量由单独 adapter 接入 |
| stronghold-server:shared/protocol.js | 插件/模式/内容确认协议与上游客户端、校验逻辑一致 | queue.*、实验模式与容量字段、负载状态/诊断 | 上游 schema 为主；按 feature 注册扩展消息，客户端/服务端/版本协商成对 |
| 两个来源 profile 的 server/index.js | 插件 registry、内容 hash/consent、每房间 Match host、trusted runtime、CSP 与资源索引 | Worker 池、独立 rehearsal 计算池、健康/流量、压缩、公告/OAuth、素材跳转与既有 ModBridge | 保留上游启动/关闭入口；自有能力按可关闭 boot/shutdown adapter 逐个接入 |
| 客户端 public/** | 新 DOM、路由与工坊/插件页面结构一致，减少旧结构耦合 | 公告、伤害板、皮肤/干员预设、素材回退和原有交互 | 不覆盖整目录；新增页面独立挂载，同路径 UI 逐组件迁移 |
| 资源寻址与 data/assets.json | 与当前生成器、hash 和加载器格式一致 | 自有 CDN 跳转、源探测、缓存与失败回退 | 清单由上游生成，自有解析/测速逻辑独立挂载；未跟踪资源需另验 |
| WebSocket/网络/遥测 | 握手、鉴权、心跳、协议验证的单一事实来源 | 压缩、流量/健康监测及诊断 | 先保留上游协议；压缩/观测通过可关闭 adapter，测试背压/重连/旧客户端 |
| build、依赖与 lockfile | 当前版本依赖和构建约定正确 | 自有校验、发布与诊断脚本 | 分开合并 scripts/runtime/devDependencies/lockfile；干净安装后全量打包 |
| Stardust 部署/反代/sidecar | 默认部署简单且不绑定专用环境 | 保留实际生产集群、反代与运维自动化 | 只在 deployment profile 显式选入，不进默认游戏运行树 |
| 来源分支删除但目标上游仍有的路径 | 保留新版本依赖与回归代码 | 自有分支可能已有替代实现或刻意清理 | 默认保留上游；只有引用与替代实现审计后才应用删除 |

### 状态说明

- 独立玩法清单和 reference 文件隔离：IMPLEMENTED。
- 混合挂载路径 deferredMixedPaths 报告逻辑及回归测试：IMPLEMENTED，等待 Actions 实跑后才可标 PASS。
- 最新 pinned source blobs 的真实冲突/hunk 列表：PENDING，不得用之前受换行/树索引影响的统计代替。
- 玩法 adapter 的实际运行、联机测试与全量回归：PENDING。保存源文件不等于已挂载运行。
- 你对非玩法公共接口取舍的决定：PENDING；不会默认选上游或来源整文件。
