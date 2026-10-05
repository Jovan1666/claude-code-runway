# 数据从哪来、多久更新一次

这份文档回答一个问题：**屏幕上每一个数字，是真数据还是写死的？**
（用户原话："这些数据是具备时效性、准确性，和按照实际变化的适应性的吧？"
"这些东西都是会实时变动的，你写死了肯定是没有用的。"）

分类只有四种：

| 记号 | 含义 |
|---|---|
| **live** | 来自接口或官方文档页，官方一改就跟着变 |
| **derived** | 本地从 live 数据算出来的（同一个数据源，同一个时效） |
| **const** | 设计常量：文案、阈值、条宽、列数上限 —— 本就该写死 |
| **⚠️ 写死** | 写死的**数据**（额度、价格、系数、名称）—— 官方一变就错 |

---

## 一、额度：`api.commandcode.ai`，**180 秒**一次

| 显示的东西 | 来源 | 分类 |
|---|---|---|
| `5h 25%` / `$3.52 / $14.00` | `windowLimits.fiveHour.{used,cap,resetAt}` | live |
| `周 40%` / `$14.04 / $35.00` | `windowLimits.weekly.*` | live |
| 月余额、已花 | `credits.monthlyCredits` + `usage/summary.totalCost` | live |
| `均单价 $0.0038/次`、`本期 15798 次请求` | `summary.{averageCost,totalCount}` | live |
| 周期起止、`周期还剩 16 天` | `subscriptions.{currentPeriodStart,currentPeriodEnd}` | live |
| 会员名 `GOAT` | `subscriptions.planId` → 查表；查不到就从 id 推 | live |
| 档位（宽裕/偏紧/吃紧/断粮） | `tierOf()` 从 used 与周期算 | derived |
| `预计 10/08 12:58 断粮`、`还能撑 2.8d` | `computePace()` + `exhaustAtMs()` | derived |
| `周期末预计 $120 / $70.36`、`会超 $49.81` | 同上 | derived |
| `进度 周期已过 49%` | `cycleProgress()`，来自周期起止 | derived |
| `均速 $4.01/天（样本 15d）` | `computePace()` | derived |
| `安全线 每天 ≤ $0.731 就不会超` | `safeDailyBudget()` | derived |
| `快照 91 秒前` | 本地记的取数时刻 | derived |
| 试算结果 | 纯本地算术 | derived |

**刷新节奏**（`hooks/register.mjs` 里的真实常量）：

- 会话启动取一次；
- 之后每 **180 秒**（`TTL_MS`）一次；
- 每轮对话结束后去抖 **15 秒**（`TURN_DEBOUNCE_MS`）补一次；
- 取数挂起超过 **45 秒**（`FETCH_HUNG_MS`）当失败，允许下次重试 —— `$.http.fetch` 没有
  timeout，网关黑洞会让它永远挂着；
- 超过两个周期（6 分钟）没取到 → 整行转暗并**写明"读数可能已过期 / 刷新失败"**。

### 月总额是**推**出来的，不是接口给的

接口只给余额（`monthlyCredits`）和滚动窗口的上限，**没有"这个档位一个月多少"**。
所以：

```
月总额 = 本周期已花（summary.totalCost）+ 当前余额（余额三项之和）
```

`summary` 是带 `since=<周期起点>` 取的，所以就是本周期口径 —— 官方调价/改档时它会**跟着变**。
写死的档位上限（`PLANS.monthly`）只在连 `summary` 都拿不到时兜底。

> 所以有时候会看到 `$59.24 / $70.36` 这种"不整"的总量 —— 那是推出来的活数字，
> 不是写死的 `$70.00`。

**已知偏差**：用户**另买了额度**时，余额含购买部分而"已花"不含 → 分母偏大、百分比偏低。

---

## 二、模型次数表：官方文档页，**24 小时**一次

「这个套餐下每个模型还能调用多少次」**不在 API 里** —— `/alpha/*` 不暴露那张表。
官方只把它印在公开文档页上：

| 显示的东西 | 来源 | 分类 |
|---|---|---|
| 表里每一行的次数 | `GET commandcode.ai/docs/plans/<slug>`（头 `RSC: 1`）的 `rows[].{budgetUsd,rates,shape}` | live |
| 5h / 周 的换算系数 | 同一个页面的 `fiveHourFraction` / `weeklyFraction` | live |
| `★新` / `↑价` | 与上一次抓到的目录比出来的 | derived |
| `官方 16 分钟前更新` | 本地记的抓取时刻 | derived |

刷新：后台 **24 小时**一次（模型上下架、调价是天级的事），失败隔 6 小时重试；
**`/quota models` 强制重抓一次**（最多等 8 秒）—— 显式要表就是要现在的真相。
抓不到就保留旧目录并**标出"多久之前抓的"**，不假装新鲜。

> **曾经写死过**：窗口系数有一张 `GO_FRACTIONS` 表（`individual-go` → 0.2/0.5），
> 理由是"页面只反映当前那一代"。实测推翻 —— Go 页面此刻给的是 **0.3 / 0.6**，
> 那张表把 live 值压掉了，5h/周 的次数**比真值低三分之一**。
> 现在**以页面为准**，表清空了，测试里有一条断言钉着它必须是空的。

---

## 三、token-weather（上下文 / 缓存）：**每回合 + 每秒**

| 显示的东西 | 来源 | 分类 |
|---|---|---|
| `52% of context`、`500k / 967k` | `$.session.usage()` 的 `context` | live |
| 缓存命中率 `◉ cache 87%` | `turn.complete` 的 `e.usage.{cache_read,cache_creation,input}_tokens` | live |
| 进度条 | 从命中率算 | derived |
| `⧗ 4:12` 倒计时 | 上次请求时刻 + 5 分钟 TTL | derived |
| `$` 会话花费 | **已删除** —— 走第三方代理时那个数按官方单价硬乘出来，跟实际花费无关 | — |

⚠️ **唯一一处"估计"**：prompt cache 的 TTL 逐回合**读不到真值**
（类型定义里 `cache_ttl` 只出现在 `/model` 切换和 resume/fork 的载荷里），
所以按官方默认 **5 分钟**倒计时。文案里不当成事实。

---

## 四、还剩下哪些写死的东西

| 写死的 | 用在哪 | 会不会出错 |
|---|---|---|
| `PLANS` 的 `name` | 会员名的**美化**（`individual-goat` → `GOAT`） | 不会：查不到就从实时 planId 推（`individual-titan` → `Titan`） |
| `PLANS` 的 `monthly` / `fiveHour` / `weekly` | **只在**接口没给 `cap` / 拿不到 `summary` 时兜底 | 会 —— 官方改档时兜底值偏旧。但主路径都是 live |
| `PLAN_SLUGS` | planId → 文档页 slug | 会 —— 官方换 slug 就抓不到。抓不到时整段不显示，不影响额度 |
| `CONFIG_PATHS` | 凭据文件的查找位置 | 不是数据 |
| 阈值 / 条宽 / 列数 / 文案 | 界面 | const，本就该写死 |

**没有**写死的额度数值、模型价格、模型清单 —— 那些全部来自接口或文档页。

---

## 五、怎么自己核

```bash
node tools/preview.mjs       # 用真实数据打印 band / 面板 / 命令输出
node tools/preview.mjs --json # 额外 dump 归一化后的对象
node tools/privacy-scan.mjs   # 提交前：仓库里有没有混进本机的真实读数
```

`tools/preview.mjs` 显示的是**同一个 `layoutRow` / `layoutPane` 纯函数**产出的东西，
与真机同源 —— 所以它打印出来的百分比、断粮时刻、模型表，就是屏幕上会看到的。
