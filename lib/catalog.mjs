// runway · 模型次数目录（纯函数，不出现 `$`，可测可预览）
//
// 「这个套餐下，每个模型大概还能调用多少次」—— Command Code 只在**公开文档页**上
// 公布这张表，`/alpha/*` 接口不暴露它。所以这里解析的是 docs 站的 RSC 流：
//
//     GET https://commandcode.ai/docs/plans/<slug>     头：RSC: 1
//     → text/x-component（Next.js 的 flight 流，约 200 KB，公开页、不需要凭据）
//
// 口径（照抄官方页面的算法，dsh-commandcode-quota 的 catalog.mjs 是同一套）：
//
//     每次成本 = 输入/1e6×输入单价 + 输出/1e6×输出单价 + 缓存读/1e6×缓存读单价
//     月次数   = 该模型的 budgetUsd ÷ 每次成本
//     5h 次数  = 月次数 × fiveHourFraction
//     周次数   = 月次数 × weeklyFraction
//
// **每个模型有自己的 budgetUsd**（GOAT 里 DeepSeek V4.1 Flash 是 $60、GPT-5.6 Sol 是 $70），
// 套餐级的那个 $70 不参与这条公式 —— 官方两处口径不同，不能互相推算。

// planId → docs 页 slug。官方 planId 与「套餐名」不是一回事，别拿 PLANS 的键来对。
const PLAN_SLUGS = {
  'individual-go': 'go',
  'individual-go-v1': 'go',
  'individual-goat': 'goat',
  'individual-pro': 'pro',
  'individual-pro-v1': 'pro',
  'individual-max': 'max',
  'individual-ultra': 'max', // 官方没有独立专页，按 Max 推断
};

// ⚠️ 这里**曾经**有一张写死的 GO_FRACTIONS 表（individual-go → 0.2/0.5，
// individual-go-v1 → 0.3/0.6），理由是"页面 props 只反映当前那一代，老套餐会低估"。
//
// 2026-10-05 实测把它推翻了：**Go 页面此刻给的正是 0.3 / 0.6**，而那张写死的表
// 对 `individual-go` 覆盖成 0.2 / 0.5 —— 于是 5h/周的可调用次数**比真值低三分之一**。
// 这就是"拿写死的盖住实时的"最典型的翻车方式。
//
// 现在**以页面为准**（它就是官方此刻公布的口径）。至于某个老套餐的历史系数是否与
// 当前页面不同 —— 那是个假设，没有证据，不该拿它去覆盖实测数据。
export const GO_FRACTIONS = {};

export function planSlug(planId) {
  if (!planId || typeof planId !== 'string') return null;
  return PLAN_SLUGS[planId.toLowerCase().replace(/_/g, '-')] ?? null;
}

export function catalogUrl(planId) {
  const slug = planSlug(planId);
  return slug ? 'https://commandcode.ai/docs/plans/' + slug : null;
}

// ── 解析 ──
// flight 流是「一行一条记录」：`<id>:<JSON>`；id 每次部署都会变，
// 所以只按**结构签名**找那条记录（有 rows、有 budgetUsd、有两个窗口系数），
// 绝不按 id 匹配。

function findEstimate(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findEstimate(x);
      if (r) return r;
    }
    return null;
  }
  if (
    typeof node.fiveHourFraction === 'number' &&
    typeof node.weeklyFraction === 'number' &&
    Array.isArray(node.rows) &&
    node.rows.some((r) => r && typeof r.budgetUsd === 'number' && isObj(r.rates) && isObj(r.shape))
  ) {
    return node;
  }
  for (const v of Object.values(node)) {
    const r = findEstimate(v);
    if (r) return r;
  }
  return null;
}

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

const flightRe = /^([0-9a-f]+):(.*)$/;

export function parsePlanEstimates(text) {
  if (typeof text !== 'string' || !text) return null;
  // 压缩过的响应不能当文本解析 —— 早失败好过解析出半张表。
  if (text.charCodeAt(0) === 0x1f && text.charCodeAt(1) === 0x8b) return null;
  if (!text.includes('budgetUsd') || !text.includes('fiveHourFraction')) return null;

  for (const line of text.split('\n')) {
    const m = flightRe.exec(line);
    if (!m) continue;
    let v;
    try {
      v = JSON.parse(m[2]);
    } catch {
      continue;
    }
    const est = findEstimate(v);
    if (!est) continue;
    const rows = est.rows.filter(
      (r) => r && typeof r.name === 'string' && r.name && typeof r.budgetUsd === 'number' && isObj(r.rates) && isObj(r.shape),
    );
    if (!rows.length) continue;
    return {
      rows,
      fiveHourFraction: est.fiveHourFraction,
      weeklyFraction: est.weeklyFraction,
    };
  }
  return null;
}

// ── 换算 ──

function costOf(row) {
  const r = row.rates;
  const s = row.shape;
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return (
    (n(s.inputTokens) / 1e6) * n(r.inputCost) +
    (n(s.outputTokens) / 1e6) * n(r.outputCost) +
    (n(s.cacheReadTokens) / 1e6) * n(r.cacheReadCost)
  );
}

// 官方展示口径：有效数字 3 位，再按 en-US 加千位分隔（154,000 / 30,800）。
export function fmtCount(n) {
  if (!Number.isFinite(n)) return '—';
  return Number(n.toPrecision(3)).toLocaleString('en-US');
}

// 原始解析结果 → 可直接上屏的目录。按**每月次数降序**：
// 次数最多 = 每美元能买到的请求最多 = 最该被看见的那一档。
export function buildCatalog(raw, planId, at) {
  if (!raw || !Array.isArray(raw.rows) || !raw.rows.length) return null;
  const slug = planSlug(planId);
  const go = GO_FRACTIONS[String(planId || '').toLowerCase().replace(/_/g, '-')];
  const fh = go ? go.fiveHour : raw.fiveHourFraction;
  const wk = go ? go.weekly : raw.weeklyFraction;

  const models = [];
  for (const row of raw.rows) {
    const cost = costOf(row);
    const monthly = cost > 0 ? row.budgetUsd / cost : null; // cost 为 0 → 官方显示 Free
    models.push({
      name: row.name,
      budgetUsd: row.budgetUsd,
      costPerRequest: cost > 0 ? cost : null,
      monthly,
      fiveHour: monthly == null ? null : monthly * fh,
      weekly: monthly == null ? null : monthly * wk,
      hasTimeOfDay: isObj(row.timeOfDay),
    });
  }
  // 次数算不出来的（Free）排在最后，而不是当成 0 混在中间。
  models.sort((a, b) => (b.monthly ?? -1) - (a.monthly ?? -1));
  return { slug, planId: planId ?? null, fiveHourFraction: fh, weeklyFraction: wk, models, fetchedAt: at ?? null };
}

// ── 和上一份比：哪些是新的、哪些改了价 ──
// 用户要的就是这个：「看看它有没有更新哪些新的又便宜又好用的模型」。
export function catalogDiff(prev, next) {
  const empty = { added: new Set(), repriced: new Set(), removed: new Set() };
  if (!next || !Array.isArray(next.models)) return empty;
  if (!prev || !Array.isArray(prev.models) || !prev.models.length) return empty;

  const before = new Map(prev.models.map((m) => [m.name, m]));
  const added = new Set();
  const repriced = new Set();
  for (const m of next.models) {
    const old = before.get(m.name);
    if (!old) {
      added.add(m.name);
      continue;
    }
    // 单价或月度份额变了 = 官方调过价。比字符串的话会误报，所以比数值。
    if (Math.abs((old.costPerRequest ?? 0) - (m.costPerRequest ?? 0)) > 1e-9 || (old.budgetUsd ?? 0) !== (m.budgetUsd ?? 0)) {
      repriced.add(m.name);
    }
  }
  const now = new Set(next.models.map((m) => m.name));
  const removed = new Set(prev.models.map((m) => m.name).filter((n) => !now.has(n)));
  return { added, repriced, removed };
}

// 目录本身的新鲜度。官方是实时更新的（模型上下架、调价），
// 所以「什么时候抓的」必须能看见 —— 不然一张过期表比没有表更误导。
export function catalogAge(catalog, now) {
  if (!catalog || !catalog.fetchedAt) return null;
  const ms = Math.max(0, (Number(now) || 0) - catalog.fetchedAt);
  if (ms < 90_000) return '刚刚更新';
  if (ms < 3600_000) return Math.round(ms / 60_000) + ' 分钟前更新';
  if (ms < 48 * 3600_000) return Math.round(ms / 3600_000) + ' 小时前更新';
  return Math.round(ms / 86400_000) + ' 天前更新';
}
