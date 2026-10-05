// runway · 模型次数目录的测试
//
//   claude plugin test
//
// 夹具是一段**真实格式**的 flight 流（从 commandcode.ai/docs/plans/goat 抄下来的结构，
// 数值换成可心算的合成值）。不联网 —— 联网的测试会在没网、被墙、官方改版时红，
// 而它红的不是我们的 bug。

import { expect, test } from 'claude-code/testing';

import {
  GO_FRACTIONS,
  buildCatalog,
  catalogAge,
  catalogDiff,
  catalogUrl,
  fmtCount,
  parsePlanEstimates,
  planSlug,
} from '../lib/catalog.mjs';

const fmt = (...rows) =>
  rows.map((r, i) => `${(i + 10).toString(16)}:${JSON.stringify(r)}`).join('\n');

// 一条套餐页记录：props 挂在数组的第三个位置（真实结构就是这样）
const page = (rows, fiveHour = 0.2, weekly = 0.5) => {
  const props = { rows, fiveHourFraction: fiveHour, weeklyFraction: weekly };
  return `3:I[43596,[],""]\n1c:["$","$L47",null,${JSON.stringify(props)}]\n1d:["$","p",null,{}]`;
};

// DeepSeek V4.1 Flash 在 GOAT 上的真实数值（官方页面上的 154,000 / 30,800 / 76,900）
const DEEPSEEK = {
  name: 'DeepSeek V4.1 Flash',
  budgetUsd: 60,
  rates: { inputCost: 0.15, outputCost: 0.6, cacheReadCost: 0.003 },
  shape: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 50000 },
};
const SOL = {
  name: 'GPT-5.6 Sol',
  budgetUsd: 70,
  rates: { inputCost: 5, outputCost: 30, cacheReadCost: 0.5 },
  shape: { inputTokens: 800, outputTokens: 160, cacheReadTokens: 50000 },
};

// ── 解析 ──

test('parsePlanEstimates 按结构签名找到那张表，不靠 record id', () => {
  const raw = parsePlanEstimates(page([DEEPSEEK, SOL]));
  expect(raw).not.toBe(null);
  expect(raw.rows.length).toBe(2);
  expect(raw.rows[0].name).toBe('DeepSeek V4.1 Flash');
  expect(raw.fiveHourFraction).toBe(0.2);
  expect(raw.weeklyFraction).toBe(0.5);
});

test('parsePlanEstimates 对压缩响应 / 无关文本 / 空值返回 null，而不是半张表', () => {
  // gzip 魔数
  expect(parsePlanEstimates('\u001f\u008b\b\u0000garbage')).toBe(null);
  // 长得像 flight 但没有那张表
  expect(parsePlanEstimates('1:"hello"\n2:{"rows":[]}')).toBe(null);
  expect(parsePlanEstimates('')).toBe(null);
  expect(parsePlanEstimates(null)).toBe(null);
  // 有 rows 但缺窗口系数 —— 不能当成有效目录（否则次数会全按 undefined 算成 NaN）
  const noFractions = '1c:["$","x",null,' + JSON.stringify({ rows: [DEEPSEEK] }) + ']';
  expect(parsePlanEstimates(noFractions)).toBe(null);
});

test('parsePlanEstimates 跳过坏行不整段失败', () => {
  const text = `1:"不是 JSON 的一行"\n2:{也不是}\n${page([DEEPSEEK])}`;
  const raw = parsePlanEstimates(text);
  expect(raw).not.toBe(null);
  expect(raw.rows.length).toBe(1);
});

// ── 换算 ──

test('换算对上官方页面上的 154,000 / 30,800 / 76,900', () => {
  const cat = buildCatalog(parsePlanEstimates(page([DEEPSEEK, SOL])), 'individual-goat', 0);
  const m = cat.models.find((x) => x.name === 'DeepSeek V4.1 Flash');
  // 每次成本 = 800/1e6×0.15 + 200/1e6×0.6 + 50000/1e6×0.003 = 0.00039
  expect(Math.round(m.costPerRequest * 1e8) / 1e8).toBe(0.00039);
  expect(fmtCount(m.monthly)).toBe('154,000');
  expect(fmtCount(m.fiveHour)).toBe('30,800');
  expect(fmtCount(m.weekly)).toBe('76,900');
});

test('每个模型用自己的 budgetUsd，套餐级的那个数不参与', () => {
  const cat = buildCatalog(parsePlanEstimates(page([DEEPSEEK, SOL])), 'individual-goat', 0);
  const sol = cat.models.find((x) => x.name === 'GPT-5.6 Sol');
  // Sol 拿的是 $70 而不是 $60：同一个套餐里两个模型份额本来就不同
  expect(sol.budgetUsd).toBe(70);
  expect(sol.monthly).toBeGreaterThan(0);
  expect(sol.monthly).toBeLessThan(10000);
});

test('表按每月次数降序 —— 每美元能买到最多请求的排最前', () => {
  const cat = buildCatalog(parsePlanEstimates(page([SOL, DEEPSEEK])), 'individual-goat', 0);
  expect(cat.models[0].name).toBe('DeepSeek V4.1 Flash');
  expect(cat.models[1].name).toBe('GPT-5.6 Sol');
});

test('窗口系数以**页面**为准，不用写死的表覆盖', () => {
  // 这条是踩出来的：曾经有一张写死的 GO_FRACTIONS（individual-go → 0.2/0.5），
  // 理由是"页面只反映当前那一代"。实测 Go 页面此刻给的是 **0.3 / 0.6** ——
  // 那张表把 live 值盖掉了，5h/周的可调用次数**比真值低三分之一**。
  // 教训：不要拿假设去覆盖实测数据。
  const raw = parsePlanEstimates(page([DEEPSEEK], 0.3, 0.6));
  for (const planId of ['individual-go', 'individual-go-v1', 'individual-goat', 'individual-max']) {
    const cat = buildCatalog(raw, planId, 0);
    expect(cat.fiveHourFraction).toBe(0.3);
    expect(cat.weeklyFraction).toBe(0.6);
  }
  // 页面给什么就用什么 —— 连"更保守"的换算都不做
  const other = buildCatalog(parsePlanEstimates(page([DEEPSEEK], 0.25, 0.45)), 'individual-go', 0);
  expect(other.fiveHourFraction).toBe(0.25);
  expect(other.weeklyFraction).toBe(0.45);
  // 覆盖表必须保持空的（留着它就会有下一个人重新填进去）
  expect(Object.keys(GO_FRACTIONS)).toEqual([]);
});

test('单价为 0 的模型算不出次数，显示 Free 而不是 0', () => {
  const free = { name: 'Jev', budgetUsd: 20, rates: { inputCost: 0, outputCost: 0, cacheReadCost: 0 }, shape: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 50000 } };
  const cat = buildCatalog(parsePlanEstimates(page([free])), 'individual-goat', 0);
  const m = cat.models[0];
  expect(m.monthly).toBe(null);
  expect(fmtCount(m.monthly)).toBe('—');
});

// ── 新增 / 改价 ──

test('catalogDiff 认出新增和改价，第一次运行不误报', () => {
  const first = buildCatalog(parsePlanEstimates(page([DEEPSEEK, SOL])), 'individual-goat', 1);
  // 第一次（没有上一份）→ 什么都别报，否则整个表都是「新」
  expect(catalogDiff(null, first).added.size).toBe(0);

  const NEW = { name: 'Qwen 4.0 Turbo', budgetUsd: 20, rates: { inputCost: 0.1, outputCost: 0.2, cacheReadCost: 0.001 }, shape: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 50000 } };
  const cheaper = { ...DEEPSEEK, rates: { inputCost: 0.075, outputCost: 0.6, cacheReadCost: 0.003 } };
  const second = buildCatalog(parsePlanEstimates(page([cheaper, SOL, NEW])), 'individual-goat', 2);

  const d = catalogDiff(first, second);
  expect([...d.added]).toEqual(['Qwen 4.0 Turbo']);
  expect([...d.repriced]).toEqual(['DeepSeek V4.1 Flash']);
  expect(d.removed.size).toBe(0);
});

test('catalogDiff 认得出下架的模型', () => {
  const a = buildCatalog(parsePlanEstimates(page([DEEPSEEK, SOL])), 'individual-goat', 1);
  const b = buildCatalog(parsePlanEstimates(page([DEEPSEEK])), 'individual-goat', 2);
  expect([...catalogDiff(a, b).removed]).toEqual(['GPT-5.6 Sol']);
});

// ── slug 与新鲜度 ──

test('planSlug 覆盖官方 planId，且不把 individual-go 误配成 goat', () => {
  expect(planSlug('individual-goat')).toBe('goat');
  expect(planSlug('individual-go')).toBe('go');
  expect(planSlug('individual-go-v1')).toBe('go');
  expect(planSlug('individual-pro')).toBe('pro');
  expect(planSlug('individual-max')).toBe('max');
  expect(planSlug('individual-ultra')).toBe('max');
  expect(planSlug('teams-pro')).toBe(null); // 没有对应文档页 → 不猜
  expect(planSlug(null)).toBe(null);
  expect(catalogUrl('individual-goat')).toBe('https://commandcode.ai/docs/plans/goat');
  expect(catalogUrl('teams-pro')).toBe(null);
});

test('catalogAge 说人话，且过期会被看见', () => {
  const cat = buildCatalog(parsePlanEstimates(page([DEEPSEEK])), 'individual-goat', 1000);
  expect(catalogAge(cat, 1000 + 30_000)).toBe('刚刚更新');
  expect(catalogAge(cat, 1000 + 30 * 60_000)).toBe('30 分钟前更新');
  expect(catalogAge(cat, 1000 + 5 * 3600_000)).toBe('5 小时前更新');
  expect(catalogAge(cat, 1000 + 3 * 86400_000)).toBe('3 天前更新');
  expect(catalogAge(null, 1)).toBe(null);
});

// ── 上屏那一段（面板 + /quota models）──
//
// 这一段是**排版**，在 lib/quota.mjs 里；表本身在 catalog.mjs。
// 之所以也放在这个文件测：它俩的契约是一条，拆开测没有意义。

const NL = String.fromCharCode(10);

import { computePace, dispWidth, layoutPane, modelTable, modelTableText, normalize, tierOf } from '../lib/quota.mjs';

// 面板那一段测试要用一份真实形状的读数。
//
// ⚠️ **数值必须是合成的。** 这个仓库有一条硬规矩：真实账单数据不得入库。
// 曾经有夹具直接把真机上的读数抄进来（连"仅此一次"的金额和请求数一起），
// 随公开仓库出去了 —— 数字看着不起眼，但它就是账户的使用记录。
// 下面照着 `tests/quota.test.ts` 那份合成夹具写，**不要从真机上抄**。
const NOWFIX = Date.parse('2026-03-10T00:00:00.000Z');
const CAT_VIEW = () =>
  normalize(
    {
      credits: { credits: { monthlyCredits: 21.5 }, windowLimits: { limited: true,
        fiveHour: { used: 3.1, cap: 14, resetAt: NOWFIX + 3060000, exceeded: false },
        weekly: { used: 8.2, cap: 35, resetAt: NOWFIX + 6 * 86400000, exceeded: false } } },
      subscription: { data: { status: 'active', planId: 'individual-goat',
        currentPeriodStart: new Date(NOWFIX - 14 * 86400000).toISOString(),
        currentPeriodEnd: new Date(NOWFIX + 16 * 86400000).toISOString() } },
      summary: { totalCost: 32.6, totalCount: 4200, averageCost: 0.00776 },
    },
    { now: NOWFIX },
  );

const CAT = buildCatalog(parsePlanEstimates(page([DEEPSEEK, SOL])), 'individual-goat', 1_000_000);
const ALL = buildCatalog(
  parsePlanEstimates(page([DEEPSEEK, SOL, { name: 'Qwen 4.0 Turbo', budgetUsd: 20, rates: { inputCost: 0.1, outputCost: 0.2, cacheReadCost: 0.001 }, shape: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 50000 } }])),
  'individual-goat',
  1_000_000,
);
const NEW_ONLY = catalogDiff(CAT, ALL);
const NULLISH = null; // 没有上一份目录时 diff 传 null // Qwen 是新的，DeepSeek 改了价（budget 一样但 cost 一样？）

const textOf = (rows) => rows.map((r) => r.map((x) => x.text).join(''));
const cells = (rows) => rows.map((r) => r.map((x) => x.text));
// 一行拼成一句，用来做"读起来对不对"的断言
const line = (row) => row.map((x) => x.text).join('');

test('modelTable 的标题说清口径、模型数和新鲜度', () => {
  const head = line(modelTable(CAT, null, 78, 1_000_000)[0]);
  expect(head).toContain('每月可调用次数');
  expect(head).toContain('2 个');
  expect(head).toContain('刚刚更新');
});

// 标题要在**实机侧边栏宽度**里放得下。
//
// 50 是量出来的、不是猜的：`band-probe` 从引擎读到的 pane `bodyColumns` 就是 50
// （mod 里 `$.ui.open({ columns: 78 })` 只是"请求值"）。放不下就被 `truncTo` 截断，
// 而截掉的正好是结尾的新鲜度 —— 那是这张表最要紧的一句。
// 这条锁的是"不许再写长"，不是某个具体措辞。
test('modelTable 的标题在实机 50 列里放得下 —— 时效那句不能被截掉', () => {
  const NOW = 1_000_000;
  // 覆盖 catalogAge 的每一档 + 最长的那档（"47 小时前更新"最宽）
  for (const mins of [0, 16, 300, 60 * 47, 60 * 24 * 3, 60 * 24 * 30]) {
    const cat = { ...CAT, fetchedAt: NOW - mins * 60_000 };
    const head = line(modelTable(cat, null, 50, NOW)[0]);
    expect(dispWidth(head) <= 50).toBe(true);
    expect(head).toContain('更新'); // 时效那句还在，没被切掉尾巴
  }
});

const w = (r) => dispWidth(line(r));
// 表格行 = 标题之后、脚注之前的那几行
const tableRows = (rows) => rows;

test('modelTable **一行只能有一个段** —— 这是对齐的命根子', () => {
  // 面板把每个段渲染成独立的文本节点，而**节点边界的空白会被吃掉**。
  // 先前为了给标记单独染色把一行切成名字/标记/数字三段，补齐的空格正好落在边界上，
  // 于是列全歪（用户截图报的）。一行一段，补齐空格就是这段文字的一部分，不会被重算。
  for (const r of modelTable(ALL, NEW_ONLY, 50, 1_000_000)) {
    expect(r.length).toBe(1);
    expect(r[0].prio).toBe(0); // 且不可丢 —— 否则 fitSegments 会摘掉整行
  }
});

test('modelTable 没有框线 —— 面板里画不出好看的线，那就不画', () => {
  const all = modelTable(ALL, NEW_ONLY, 50, 1_000_000).map(line).join('');
  // box-drawing 是 Ambiguous 宽度（字体说了算），ASCII 框线则显得笨重 —— 两版都试过了
  expect(/[\u2500-\u257f]/.test(all)).toBe(false);
  expect(/^\+[-+]*\+$/m.test(all)).toBe(false);
  expect(all.includes('|')).toBe(false);
});

test('modelTable 是两列对齐的表：表头压在列上、每行等宽', () => {
  const rows = modelTable(ALL, NULLISH, 50, 1_000_000);
  const L = rows.map(line);
  const header = L[1];
  const data = L.slice(2, rows.length - (L[L.length - 1].startsWith('…') ? 1 : 0));

  // 每行等宽（除标题/脚注那两行自由流动的说明文字）
  const widths = new Set(data.map((l) => dispWidth(l)));
  expect(widths.size).toBe(1);
  expect([...widths][0]).toBeLessThanOrEqual(49);

  // 表头和数据行同宽 —— 说明用的是同一套列宽
  expect(dispWidth(header)).toBe([...widths][0]);

  // 数字列右对齐：每行末尾的数字串右边缘一致
  const numberEnd = (l) => l.length; // 都是补齐到同一宽度
  expect(new Set(data.map(numberEnd)).size).toBe(1);
  expect(header.endsWith('每月调用')).toBe(true);
  expect(data[0].endsWith('154,000')).toBe(true);
});

test('modelTable 把新增/改价的钉在最前面，标记在名字列里', () => {
  const cheaper = { ...DEEPSEEK, rates: { ...DEEPSEEK.rates, inputCost: 0.075 } };
  const withNew = { name: 'Qwen 4.0 Turbo', budgetUsd: 20, rates: { inputCost: 0.1, outputCost: 0.2, cacheReadCost: 0.001 }, shape: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 50000 } };
  const next = buildCatalog(parsePlanEstimates(page([SOL, cheaper, withNew])), 'individual-goat', 2);
  const L = modelTable(next, catalogDiff(CAT, next), 78, 2).map(line);
  // 0 标题 / 1 列头 / 2、3 被钉住的两个（★新 在前、↑价 在后）
  expect(L[2]).toContain('Qwen 4.0 Turbo');
  expect(L[2]).toContain('★新');
  expect(L[3]).toContain('DeepSeek V4.1 Flash');
  expect(L[3]).toContain('↑价');
  // 标记在名字列内，所以有标记/没标记的行**一样宽**
  const plain = modelTable(CAT, null, 78, 2).map(line);
  expect(dispWidth(L[2])).toBe(dispWidth(plain[2]));
});

test('modelTable 窄的时候截断名字，列仍然对齐', () => {
  const narrow = modelTable(ALL, null, 30, 1_000_000).map(line);
  const data = narrow.slice(2, -1);
  expect(data.some((l) => l.includes('…'))).toBe(true);
  expect(new Set(data.map((l) => dispWidth(l))).size).toBe(1);
  expect(dispWidth(data[0])).toBeLessThanOrEqual(29);
});

test('modelTable 行数受 limit 约束，并如实说还有多少没显示', () => {
  // 夹具只有 3 个模型 → 标题 + 列头 + 3 行（全展示，没有脚注）
  expect(modelTable(ALL, null, 50, 1_000_000).length).toBe(2 + 3);
  // limit=2 → 标题 + 列头 + 2 行 + 脚注
  const two = modelTable(ALL, null, 50, 1_000_000, 2).map(line);
  expect(two.length).toBe(3 + 2);
  expect(two.join(' ')).toContain('其余 1 个');
  expect(two.join(' ')).toContain('/quota models');
});

test('没有目录时整段不出现 —— 拿不到官方表不该让面板少别的东西', () => {
  expect(modelTable(null, null, 78, 1)).toEqual([]);
  expect(modelTable({ models: [] }, null, 78, 1)).toEqual([]);
});

test('modelTableText 是 markdown 表格 —— 空格对齐在会话里会被吃掉', () => {
  const text = modelTableText(ALL, NEW_ONLY, 1_000_000);
  // 表头 + 分隔行 + 每个模型一行
  expect(text).toContain('| 模型 | 每月 | 5 小时 | 每周 |');
  expect(text).toContain('|---|---:|---:|---:|');
  for (const m of ALL.models) expect(text).toContain(m.name);
  expect(text.split('\n').filter((l) => l.startsWith('| ')).length).toBe(ALL.models.length + 1);
  expect(text).toContain('154,000');
  expect(text).toContain('不能互相推算');
  expect(text).not.toContain('其余');
});

test('modelTableText 转义名字里的竖线，否则表格会被拆开', () => {
  const odd = { name: 'Weird|Model', budgetUsd: 20, rates: { inputCost: 0.1, outputCost: 0.2, cacheReadCost: 0.001 }, shape: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 50000 } };
  const cat = buildCatalog(parsePlanEstimates(page([odd])), 'individual-goat', 1);
  const text = modelTableText(cat, null, 1_000_000);
  expect(text).toContain('Weird\\|Model');
  // 每一行的**未转义**竖线数一致，表格才是完整的
  const rows = text.split('\n').filter((l) => l.startsWith('| '));
  const bars = new Set(rows.map((l) => (l.replace(/\\\|/g, '').match(/\|/g) || []).length));
  expect(bars.size).toBe(1);
});

test('拿不到目录时 /quota models 说的是人话，不是空白', () => {
  expect(modelTableText(null, null, 1)).toContain('目录还没拿到');
});

test('layoutPane 带上目录才长出那一段，不带就一个字都不多', () => {
  const v = CAT_VIEW();
  const pace = computePace(v, NOWFIX);
  const tier = tierOf(v, pace);
  const flat = (rows) =>
    rows.map((r) => (r.kind === 'gap' ? '' : r.segs.map((s) => s.text ?? '').join(''))).join(NL);
  const without = flat(layoutPane(v, pace, tier, 78, NOWFIX, false, null));
  const withCat = flat(layoutPane(v, pace, tier, 78, NOWFIX, false, null, { catalog: ALL, diff: NEW_ONLY }));
  expect(without).not.toContain('每月可调用次数');
  expect(withCat).toContain('每月可调用次数');
  expect(withCat).toContain('Qwen 4.0 Turbo');
});

test('模型表里出现的颜色都必须过引擎那一关', () => {
  // 引擎只认 /^[#a-zA-Z0-9_().,% -]{1,40}$/ —— 写错一处颜色，**整棵 band 树**被丢。
  // 这条是那次事故（ansi:red）留下的护栏，凡是会上屏的颜色都要过一遍。
  const COLOR_RE = /^[#a-zA-Z0-9_().,% -]{1,40}$/;
  const rows = modelTable(ALL, NEW_ONLY, 78, 1_000_000);
  const bad = [];
  for (const r of rows) for (const seg of r) if (seg.color && !COLOR_RE.test(seg.color)) bad.push(seg.color);
  expect(bad).toEqual([]);
  // 现在整行一段，**标记没法单独染色**（染了整行都变绿）。这是为了让列对齐做的取舍：
  // 一行切成多段，段边界的补齐空格会被吃掉，列就歪了。★新 / ↑价 靠字形本身醒目。
  expect(rows.flat().filter((seg) => seg.color).length).toBe(0);
});

// ────────────────────────────────────────────────────────────
// 面板整体的信息架构（结论在最上、分组、降级）
// ────────────────────────────────────────────────────────────

const paneLines = (v, cols, extra) => {
  const pace = computePace(v, NOWFIX);
  const tier = tierOf(v, pace);
  return layoutPane(v, pace, tier, cols, NOWFIX, false, null, extra)
    .map((r) => (r.kind === 'gap' ? '' : r.segs.map((s) => s.text ?? '').join('')))
    .map((s) => s.trimEnd());
};

test('面板第一行是结论：档位 + 什么时候断粮 / 能不能撑到周期末', () => {
  const lines = paneLines(CAT_VIEW(), 78);
  const head = lines[0];
  // 档位词永远在最前面，且这一行必须给出"什么时候用完"这个结论
  expect(/^(宽裕|偏紧|吃紧|断粮|采样中)/.test(head)).toBe(true);
  expect(head).toMatch(/断粮|撑得到周期末|样本不足|额度已用完/);
});

test('面板第二行是「周期末预计」——该不该紧张的第二问', () => {
  const lines = paneLines(CAT_VIEW(), 78);
  expect(lines[1]).toContain('周期末预计');
  expect(lines[1]).toMatch(/会超|富余/);
});

test('旧的「断粮」行不再出现第二遍 —— 同一件事只说一次', () => {
  const lines = paneLines(CAT_VIEW(), 78);
  const withJie = lines.filter((l) => l.startsWith('断粮'));
  // 第一行里可以有「断粮」这个词（那是结论），但不该再有一条以「断粮」开头的独立行
  expect(withJie.length).toBe(0);
});

test('「周期进度」和「安全线」是常驻的 —— 不用先试算一次才看得到', () => {
  const lines = paneLines(CAT_VIEW(), 78);
  const joined = lines.join(NL);
  expect(joined).toContain('周期已过');
  expect(joined).toContain('额度已用');
  expect(joined).toContain('每天 ≤ ');
  expect(joined).toContain('就不会超');
});

test('面板被分成有层次的几块：结论 → 额度 → 节奏 → 模型 → 工具，块间空行', () => {
  const lines = paneLines(CAT_VIEW(), 78, { catalog: ALL, diff: NEW_ONLY });
  const idx = (needle) => lines.findIndex((l) => l.includes(needle));
  const iHead = 0;
  const iMonth = idx('月');
  const iProgress = idx('周期已过');
  const iModels = idx('每月可调用次数');
  const iTry = idx('试算');
  expect(iMonth).toBeGreaterThan(iHead);
  expect(iProgress).toBeGreaterThan(iMonth);
  expect(iModels).toBeGreaterThan(iProgress);
  expect(iTry).toBeGreaterThan(iModels);
  // 块之间有空行（不是全部挤在一起）
  expect(lines.filter((l) => l === '').length).toBeGreaterThanOrEqual(3);
});

test('窄到 40 列时结论行还在 —— 面板存在的理由不能被挤掉', () => {
  for (const cols of [78, 60, 44, 40]) {
    const head = paneLines(CAT_VIEW(), cols)[0];
    expect(head.length).toBeGreaterThan(0);
    expect(/^(宽裕|偏紧|吃紧|断粮|采样中)/.test(head)).toBe(true);
  }
});

test('框线只用 ASCII —— box-drawing 是 Ambiguous 宽度，字体说了算', () => {
  // 这是那次"表格散架"的护栏：┌─│ 这些在中文环境下可能占两格，
  // 而宽度计算按一格 → 横线比表格长一倍。
  const all = modelTable(ALL, NEW_ONLY, 66, 1_000_000).map(line).join('');
  expect(/[─-╿]/.test(all)).toBe(false); // 一个 box-drawing 字符都不许有
});

test('/quota models 的脚注不许写死 token 用量 —— 每行 shape 本来就不一样', () => {
  const text = modelTableText(ALL, NEW_ONLY, 1_000_000);
  // 以前写着「输入 800 / 输出 200 / 缓存读 50,000」，实测输出有 125/150/160/180/200 好几种
  expect(text).not.toMatch(/800\s*\/\s*200/);
  expect(text).not.toContain('50,000 tokens');
  expect(text).toContain('token 形状');
});
