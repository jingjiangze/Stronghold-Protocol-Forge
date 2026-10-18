# MOTA-MODE.md — 协同共竞：一个**对局插件**

> 规则是**内容**，不是引擎代码。`plugins/mota-coop/` 通过平台新增的 `entry.match` 能力运行；引擎里没有一行
> 「借钱 / 救援」的逻辑，只有一组通用钩子。删掉这个插件目录，引擎回到官方行为，且帧字节不变。

## 1. 平台提供的能力（`server/match/plugins.js`）

一个 `trusted` 插件可以声明 `entry.match`，其模块导出 `activate(match) → hooks`。宿主在**运行对局的进程**里加
载它（大厅进程，或该内容集的 match host），把钩子接到引擎的固定位置：

| 钩子 | 何时 | 插件能做什么 |
|---|---|---|
| `intents[type]` | 客户端发 `p.msg { plugin, type, body }` | 该插件自己的消息（`g.econ.*`、`g.revive`…） |
| `roundStart(match, round)` | 每回合玩家 `startRound` 之后 | 重置本回合计数、结算欠款 |
| `prepEnd(match, alive)` | 休整期结束、`PlayerState.endPrep` 之前 | 关单、结余转化 |
| `defersElimination(match, ps)` | LP 归零、真淘汰之前 | 返回 true → 挂起（救援窗口） |
| `settleHoldMs(match)` | 结算阶段排定时器时 | 返回毫秒 → 结算阶段延长（最长者胜） |
| `phaseExpired(match, phase)` | 被延长的阶段结束 | 收尾（窗口到期淘汰） |
| `onEliminated(match, ps)` | 真淘汰之后（结算、退出、到期） | 债务作废、阵亡分红 |
| `onLeave(match, playerId)` | 席位离开 | 关掉该席位的在途请求 |
| `publicView(match)` / `privateView(match, ps)` | 构造视图 | 追加 `m.public` / `m.private` 的键 |
| `botPrep(match, ps)` | bot 的整备步骤 | 返回 true → 插件接管这一步 |

**门禁**：`class: trusted` + `permissions: ['match.code']` + 业主 pin（`plugins/config.json` 的
`trusted.<id> = plugin.lock.json 的 sha256`）。没有 pin 不导入、不加载。窗口在**独立进程**（content set 的
match host）里跑，插件只能影响那一套内容集的对局；vanilla 房间根本不经过它。

**禁用**：删掉 `plugins/mota-coop/`，或撤掉 pin，或 `SP_PLUGIN_SCRIPTS` 未开 — 三种方式都回到官方行为。

## 2. 内容是原样的

`plugins/mota-coop/` 里的 `economy.js` / `revival.js` 与线上包同源（1,239 行），只改了 import 路径。它们按
「方法容器」写（内部大量 `this.xxx` 读写对局状态），`match.js` 用一个 Proxy 把 `this` 直接绑到 Match 上：

- 读：容器自己的方法 → 就地绑定；其余 → 读 Match（prototype 上的方法绑定，own 属性原样返回，RNG 就是后者）；
- 写：容器上没有的键 → 直接落到 Match。

所以规则代码**没有为插件改写**。

## 3. 数据

四个 `mode_xie_*` 记录仍在 `data/config.json`（纯配置），各带一个 `mota` 块。插件读取它决定是否生效：

```js
motaBlock(gd) // gd.mode.mota.enabled === true 且不是 solo
```

这条边界是**刻意的**：房间在选插件之前就要按 `variant: 'xie'` 解析出 `modeId`，所以模式记录必须先存在。
规则值（单次 1 / 每回合 4 / 全队 8 / 救援 5+5 …）由 `rules.js` 解析并 clamp。

## 4. 客户端

客户端只发 `p.msg`，收 `m.public.econ` / `m.public.revival` / `m.private.econ`：

```js
net.send({ t:'p.msg', plugin:'mota-coop', type:'g.econ.request', body:{ to:'p_1', amount:1 } })
```

没有这些键时客户端不渲染任何经济 UI（能力探针），所以其它模式零存在感。

## 5. 与模式模块的区别（为什么改成插件）

先前版本把规则放在 `server/mota/`，等于让**内容适配引擎**。现在反过来：引擎只长出 `entry.match` 这一通用能力，
规则、数值、消息类型都在插件里。后续内容（UI 面板、聊天、皮肤）走同一方向——见 FINDINGS.md §8 的剩余清单。
