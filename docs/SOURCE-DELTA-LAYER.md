# 源码差异挂载层（Source Delta Layer）

它将两个服务器仓库相对共同上游基线的增量代码交给 Forge 管理器维护。上游继续作为游戏本体；不把来源仓库作为独立运行时，也不将完整玩法重写成 Forge 插件。

## 命令

    node tools/source-overlay.mjs list
    node tools/source-overlay.mjs audit --report ./source-delta-report.json
    node tools/source-overlay.mjs compose --out ../stronghold-composed

audit 只读比较；compose 在隔离目录生成组合树。存在未裁决冲突时会生成 SOURCE-DELTA-REPORT.json 与 SOURCE-DELTA-READY.json，标记 READY=false 并返回非零状态，不得部署。

## 合并规则

- 输入固定为 upstream v0.2.5 基线、目标上游 SHA 和两个来源仓库的固定 SHA。
- 来源新增且上游没有同名路径时原样挂载。
- 同路径修改以三方合并为基础：非重叠改动自动组合；重叠 hunk 生成稳定 ID，必须明确选择来源或上游。
- config/source-delta-decisions.json 可按 profile-id:relative/path 选择 source、upstream 或 merge；单段 hunk 选择 source/upstream。高风险路径无选择时阻止 READY。
- 所有缓存与输出放在来源仓库、Forge 工作树之外；源仓库 commit 和文件不会被本工具改写。

## 分组和边界

默认把 runtime、build、operations、deployment 加入组合。文档、测试和自动化会被分类统计，但不进入默认游戏运行树。Stardust 集群/反代部署配置只在匹配的目标环境启用。

三方合并不会自动证明玩法语义兼容。上游重构若移除接口、移动状态机或更改协议，仍需适配和功能测试。data/assets.json 等生成清单及 Git 未跟踪的美术/音频/字体需单独验证。更新上游时先更新目标 SHA，再 audit、裁决、回归，最后重新 compose。