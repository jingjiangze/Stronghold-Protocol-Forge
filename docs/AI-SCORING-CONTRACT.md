# AI 评分闭环：契约、中断语义与信任模型

日期：2026-10-18　对象：插件 `mota`（`shared/scoringPolicy.js`、`shared/scoringQueue.js`、`client/js/ai/scoringRunner.js`、`server/sim/rehearsal.js`）

## 1. 已经落地的

| 项 | 状态 | 证据 |
|---|---|---|
| `scoringPolicy`（档位 / `deviceTier` / `decideScoring` / `pollIntervalFor`） | 有测试 | `test/scoring.test.mjs` 7/7 通过 |
| `scoringQueue`（入队 / 取任务 / 暂停 / 中止 / 预算） | 有测试，且补了**在途保护** | `next()` 现在在上一轮未 `done()` 前返回 null，避免单 Worker 同时跑两条 |
| `scoringRunner` 模块 | 已进插件、可加载 | `/js/ai/scoringRunner.js` 200 |

## 2. `nextTask` / `report` 契约（接线前必须定死）

`installScoring({ signals, nextTask, report })` 在 `nextTask` 不是函数时**直接返回 null**（不空转）。所以接线要提供两件事：

```
nextTask(): ScoringTask | null
  ScoringTask = { id: string, playerId?: string, cap?: number, specs?: unknown[] }
  · 来源：本地布阵库的候选（客户端 IndexedDB / 本地 JSON）
  · 全部为空时返回 null，运行器据此休眠，不忙轮询

report(task, results): void
  · results = [{ index, built, leaks, kills, score }]
  · 落点：先写本地库（幂等，按 sig 去重），再交给 outbox 上传
```

`signals()` 返回：`{ autoplay, away, screen, visible, online, pageBusy, deviceTier, queued, maxQueue }`；来源是 `store.away`、`match.public.players[].autoplay`、`document.visibilityState`、`navigator.hardwareConcurrency/deviceMemory`。

**接线顺序**：布阵库 → `nextTask`（从库里取未评分的 sig）→ Worker 评分 → `report` 回写 → outbox 上传。缺任何一环都不要接，否则会得到一个永远返回 null 的运行器。

## 3. 中断语义：`rehearsal` 只有「终止式中止」

`server/sim/rehearsal.js` 导出 `rehearsalLeaks` / `RehearsalScore` / `RehearsalRun` / `rehearsalCap(timeLimit)`，**没有逐切片 `step()` 入口**。

因此当前可用的中断只有两种：

1. **协作式**：队列的 `isAborted(task.id)` 在长任务的检查点读一次；
2. **硬中断**：终止 Worker（`worker.terminate()`），本任务作废、不计分。

**结论（写进契约，避免误用）**：在补出 `step()`/`slice()` API 之前，**不要承诺「可恢复的暂停」**——中断即丢弃该任务。若将来要支持恢复，需要在 `RehearsalRun` 上暴露：当前迭代计数、RNG 状态、可序列化的中间态。

## 4. 评分上报的信任模型（五条，未实现，按此验收）

客户端上报不可信。聚合侧按以下规则接受一条记录：

1. **只收已知 sig**：`sig` 必须已存在于 R2 的布阵语料（`packs/lineup-library/`），否则丢弃。
2. **≥3 台主机一致**：同一 `sig` 的评分至少来自 3 个不同主机（按上报来源 id 去重），才计入正式分。
3. **与服务端抽样交叉**：与 `SP_VERIFY=sample` 的服务端复算结果比对；偏差超过阈值的来源降权。
4. **每主机限速**：单主机每分钟条数上限 + 单条 ≤ 100 B；超限丢弃而非排队。
5. **fail-open**：上报通道失败**绝不影响对局**——只丢这一批，不重试阻塞、不阻断结算。

**验收方法**：构造 5 类输入（未知 sig / 单主机重复 / 与服务端偏差 / 超速率 / 通道断），逐条断言「被丢弃或被降权」且「对局不受影响」。

## 5. 当前缺口（按优先级）

1. `nextTask` / `report` 的提供者（布阵库客户端侧）——**未实现**。
2. `scoringRunner` 在 `main.js` 的安装——**未接线**。
3. 信任模型五条——**未实现**。
4. `rehearsal` 的 `step()` API——**未实现**，按第 3 节以「终止式」为准。
