# 多人经济（协同共竞）在 20 人局的平衡审计

日期：2026-10-19　对象：`plugins/mota` 的 team economy（`mode_xie_*`）＋ 20 人分组 mod

## 0. 结论

**生搬硬套会明显失衡**，而且是**双向**的：供给侧按人数线性膨胀，闸门侧是**房间级固定值**不随人数变。四个人玩是调好的，二十个人玩会同时出现「钱多到没处花」和「想借钱借不到」。

## 1. 真实数值（`mode_xie_normal.teamEconomy` + `config.economy`）

| 项 | 值 | 作用域 |
|---|---|---|
| `transfer.maxPerRequest` | 1 | 每人每笔 |
| `transfer.requestsPerRound` | 4 | **每人每回合** |
| `transfer.teamCapPerRound` | 8（+后勤 `teamCapBonus` 4/8/12/16） | **整间房每回合** |
| `reserve.convertPerPlayerMax` | 2 | **每人每回合**（结余转团队储备） |
| `reserve.perfectReward` / `fullDefenceReward` | 1 / 2 | 每回合、房级 |
| `reserve.perfectRewardCapPerRound` | 2 | **整间房每回合** |
| `relief.amount` / `perPlayerPerRound` / `teamPerRound` | 1 / 2 / **4** | 后者是**整间房每回合** |
| `projects.storehouse.costs` / `logistics.costs` | [4,4,4,4] / [4,4,4,4] | **固定总价** |
| 赏金加时 | 20 s/次，费用 4/6/8，**每回合 3 次** | **整间房每回合** |
| 玩家收入 | `min(3 + round, 12)` | **每人每回合** |

## 2. 4 人 vs 20 人的量化对照（每回合）

| 指标 | 4 人 | 20 人 | 变化 |
|---|---|---|---|
| 团队储备注入上限（`convertPerPlayerMax × 人数`） | 8 | **40** | ×5 |
| 项目总价（两个项目各 16） | 32 | 32 | 不变 |
| 满级项目所需回合 | ≈4 | **< 1** | 供给×5、价格不变 |
| 转账请求供给（`4 × 人数`） | 16 | 80 | ×5 |
| 转账实际可发放（房间 cap 8） | 8 | 8 | **不变 → 通过率 50%→10%** |
| 救济需求（`2 × 人数`） | 8 | 40 | ×5 |
| 救济实际可发放（房间 cap 4） | 4 | 4 | **不变** |
| 完美/全防奖励上限 | 2 | 2 | 不变（人均 1/5） |
| 赏金加时上限 | 3 次 = 60 s | 3 次 = 60 s | 不变（人均 1/5） |

## 3. 失衡的两种表现

1. **通胀**：结余转化是「每人 2」，20 人就是每回合 40 进团队池；而两个项目的总价固定 32 → **第一回合就能全点满**，此后再无消耗口，团队资金变成死水。
2. **闸门饥饿**：转账（8/回合）、救济（4/回合）、奖励名额（2/回合）、赏金（3/次）都是**房间级固定值**。20 人时人均配额被稀释 5 倍，绝大多数请求会被 `team cap` / `team relief cap` 拒绝——玩家看到的是「按钮能点，但一直失败」。

## 4. 建议的缩放规则（单一实现点）

所有房间级数字都来自 `server/match/gamedata.js` 的 `get teamEconomy()`（第 637 行附近，一次性解析）。在这里乘一个 **按座位数的系数** 即可，不需要改玩法逻辑：

```
k = max(1, ceil(aliveSeats / 4))        // 4 人房 k=1（行为逐字节不变）
```

| 字段 | 缩放 | 20 人时 |
|---|---|---|
| `transfer.teamCapPerRound` | `base × k` | 8 → 40 |
| `relief.teamPerRound` | `base × k` | 4 → 20 |
| `reserve.perfectRewardCapPerRound` | `base × k` | 2 → 10 |
| 赏金 `maxPerRound` | `base × k` | 3 → 15 |
| `projects[*].costs` | `cost × k` | 4 → 20（总价 32→160） |
| `perfectReward` / `fullDefenceReward` | `× k`（或改为每人一份） | 1/2 → 5/10 |

**不缩放**：`maxPerRequest`、`requestsPerRound`、`convertPerPlayerMax`、`relief.perPlayerPerRound`、`relief.amount`——这些是**个人**额度，人数增加自然放大总供给。

## 5. 配置层的开关

在 `teamEconomy` 里加两个字段，避免误伤小房间：

```json
"scaling": { "mode": "perSeat", "baseSeats": 4, "maxFactor": 5 }
```

- `mode: "fixed"` = 保持现状（4 人平衡）；
- `baseSeats: 4` 保证 ≤4 人时 `k=1`，行为不变；
- `maxFactor: 5` 封顶，避免以后 40 人局把 cap 顶到无限。

## 6. 与 20 人 mod 的关系

20 人座位已在旁路树 `repo20` 跑通（P1–P20 渲染、分队、`setMaxSeats`），但**经济插件仍是 4 人调参**。因此：

- **不要直接把 repo20 切到线上**：切过去 20 人房会立刻出现 §3 的两种失衡（4 人房不受影响）。
- 先按 §4 在 `gamedata.teamEconomy` 加缩放（改动集中在 1 个函数 + 配置字段），再做 20 人实机回归。

## 7. 待确认

1. 缩放系数用 `aliveSeats`（随淘汰减少）还是 `seatCap`（房间上限，恒定）？建议用 **`seatCap`**——房间开局就按最大人数定价，避免中途减员又突然变便宜。
2. 项目价格缩放后，后期收入（`min(3+round,12)`）是否仍够？20 人 × 12 = 240/回合的收入对 160 总价依然宽裕，可再观察。
3. 赏金加时 15 次/回合是否过长？可改成「每回合总加时封顶 120 s」而不是次数封顶。

## 8. 实施状态（2026-10-19）

- `IMPLEMENTED` — 缩放按 **seatCap** 落地：`plugins/mota/server/match/match/economy.js` 的 `scaleTeamEcon(base, seats)`
  用 `k = max(1, ceil(seats/4))` 只放大**房间级**额度（`transfer.teamCapPerRound`、`reserve.*`、`relief.teamPerRound`、
  `projects[*].costs/teamCapBonus`）；个人额度不放大。
- `IMPLEMENTED` — 赏金加时从「每回合 3 次」改为**每回合总时长封顶 120 s**（`BOUNTY_MAX_SECONDS`），
  且 `econNewRound()` 复位 `econRound.bountySec`（否则封顶会跨回合累计，实测发现并修正）。
- `PASS` — 协议级实测（本地 3013，插件 Match 跑在 match host 里）：
  - 4 座席 `m.public.econ.transferLeft = 8`，`relief.left = 4`，项目价 4；
  - 20 座席 `transferLeft = 40`，`relief.left = 20`，项目价 20；
  - PREP 的 `econ.bounty = { seconds: 20, max: 6, maxSec: 120, usedSec: 0 }`。
- `IMPLEMENTED` — 插件可拆可关：`plugins/config.json` 的 `default` 决定开局集合，房间内 `room.setPlugins` 逐项开关；
  新增 `required: ["mota"]`（`server/plugins/policy.js` + `roomSets.required()`），房间请求里缺了会被自动补上，
  即魔塔本体关不掉，其余三项（AI 代算 / 皮肤 / 20 人分队）可独立关闭。
