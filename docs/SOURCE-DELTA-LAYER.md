# 源码差异挂载层（Source Delta Layer）

它将两个服务器仓库相对共同上游基线的增量代码交给 Forge 管理器维护。上游继续作为游戏本体；不把来源仓库作为独立运行时，也不将完整玩法重写成 Forge 插件。

## 命令

    node tools/source-overlay.mjs list
    node tools/source-overlay.mjs audit --report ./source-delta-report.json
    node tools/source-overlay.mjs compose --out ../stronghold-composed

audit 只读比较；compose 在隔离目录生成组合树。存在未裁决冲突或未激活的独立功能包时会生成 SOURCE-DELTA-REPORT.json 与 SOURCE-DELTA-READY.json，标记 READY=false 并返回非零状态，不得部署。

## 合并规则

- 输入固定为 upstream v0.2.5 基线、目标上游 SHA 和两个来源仓库的固定 SHA。
- 来源新增且上游没有同名路径时原样挂载。
- 同路径修改以三方合并为基础：非重叠改动自动组合；重叠 hunk 生成稳定 ID，必须明确选择来源或上游。
- config/source-delta-decisions.json 只用于真正的公共挂载点/重叠 hunk；按 profile-id:relative/path 选择 source、upstream 或 merge，单段 hunk 选择 source/upstream。
- config/source-delta-features.json 把救援/复活、联防二段接力、全员离线冻结、房主浏览器 AI 代算列为独立功能包。
- 独立模块 Git blob 按原始字节保存到 .forge-source-features/<feature-id>/<profile>/<original-path>；仍与公共状态机交织的完整来源文件保存到 .forge-source-references/<feature-id>/<profile>/<original-path>，仅供适配器提取对照，绝不替换上游公共路径。救援/复活尚未抽成独立模块，必须保留 PENDING 标记。
- 独立源码暂存不等于运行时激活。报告会单独列出 integrationPending；适配器未接通并通过回归前，READY 仍为 false。
- 所有缓存与输出放在来源仓库、Forge 工作树之外；源仓库 commit 和文件不会被本工具改写。

## 分组和边界

默认把 runtime、build、operations、deployment 加入组合。文档、测试和自动化会被分类统计，但不进入默认游戏运行树。Stardust 集群/反代部署配置只在匹配的目标环境启用。

三方合并不会自动证明玩法语义兼容。独立玩法包不参加整文件冲突二选一，但若其依赖 Match 状态机、结算、协议、房间生命周期或浏览器 Worker，仍需由 Forge 的适配器挂载并通过功能测试。data/assets.json 等生成清单及 Git 未跟踪的美术/音频/字体需单独验证。更新上游时先更新目标 SHA，再 audit、裁决、回归，最后重新 compose。