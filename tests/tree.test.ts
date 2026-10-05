// runway · 渲染树校验（防「整个 band 静默消失」的护栏）
//
// 引擎对 ui.render 返回的树做一次校验，不过就**整棵丢弃**、改画自己的版本（= 空白），
// 屏幕上没有任何提示。而 band 是中间件链，三个 mod 的树会合并成一棵 ——
// 所以**一处写错，三块内容一起消失**。这个文件就是那次事故的护栏。
//
// 测试环境里没有引擎，所以 tools/tree_lint.mjs 重新实现了引擎那套规则
// （规则本身逐条抄自 claude.exe，颜色字符集等常量都能二进制里对上）。
// 它抓不到的：引擎改了规则而我们没跟着改 —— 所以它是一道网，不是保证。
//
// 这里驱动的是**真的 register.mjs**，覆盖 8 个数据态 × 10 个列宽 × 2 个 surface，
// band 与 pane 两条渲染路径都过一遍。

import { expect, test } from 'claude-code/testing';

import { register } from '../hooks/register.mjs';
import { computePace, layoutPane, normalize, tierOf } from '../lib/quota.mjs';
import { factorySet, validateTree } from '../tools/tree_lint.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-03-10T00:00:00.000Z');

// ── 合成响应 ──
//
// ⚠️ **数值必须是合成的。** 这个仓库有一条硬规矩：真实账单数据不得入库。
// 曾经有夹具直接把真机读数抄进来（连"仅此一次"的金额和请求数一起），
// 随公开仓库出去了 —— 数字看着不起眼，但它就是账户的使用记录。
// 下面照着 `tests/quota.test.ts` 那份合成夹具写，**不要从真机上抄**。
function rawFor(kind) {
  const base = {
    credits: {
      credits: { monthlyCredits: 21.5, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 3.1, cap: 14, exceeded: false, resetAt: NOW + 9_600_000 },
        weekly: { used: 8.2, cap: 35, exceeded: false, resetAt: NOW + 6 * DAY },
      },
    },
    subscription: {
      data: {
        status: 'active',
        planId: 'individual-goat',
        currentPeriodStart: new Date(NOW - 15 * DAY).toISOString(),
        currentPeriodEnd: new Date(NOW + 15 * DAY).toISOString(),
      },
    },
    summary: { totalCost: 32.6, totalCount: 4200, averageCost: 0.00776 },
  };
  if (kind === 'zero') {
    base.summary.totalCost = 0;
    base.summary.totalCount = 0;
  }
  if (kind === 'exhausted') {
    base.credits.credits.monthlyCredits = 0;
    base.summary.totalCost = 70;
  }
  if (kind === 'missing') delete (base.credits.credits as Record<string, unknown>).monthlyCredits;
  if (kind === 'huge') {
    base.credits.credits.monthlyCredits = 999999;
    base.summary.totalCost = 999999;
    base.summary.totalCount = 999999999;
  }
  if (kind === 'nodates') {
    delete (base.subscription.data as Record<string, unknown>).currentPeriodStart;
    delete (base.subscription.data as Record<string, unknown>).currentPeriodEnd;
  }
  return base;
}

const STATES = ['nodata', 'healthy', 'zero', 'exhausted', 'missing', 'huge', 'nodates', 'stale'];
const WIDTHS = [20, 30, 40, 56, 72, 74, 80, 103, 120, 200];

const CACHE_KEY = 'runway.cache';

function stub$(surface: string, state: string) {
  const F = factorySet(surface);
  let cached: unknown = null;
  if (state !== 'nodata') {
    const view = normalize(rawFor(state), { now: NOW });
    cached = { savedAt: state === 'stale' ? NOW - 10 * 180_000 : NOW, digest: 'x', view };
  }
  return {
    F,
    $: {
      clock: { every: () => ({ cancel() {} }), sleep: async () => {} },
      store: { get: async (k: string) => (k === CACHE_KEY ? cached : null), set: async () => {} },
      ui: { resolve: () => F, toast() {}, invalidate() {}, copy() {}, open: async () => ({ isPlaced: true }), close: async () => {} },
      command: { register: async () => {} },
      env: { get: async () => undefined },
      settings: { read: async () => ({}) },
      fs: { read: async () => { throw new Error('ENOENT'); }, exists: async () => false },
      session: { usage: async () => ({ context: null }), cwd: async () => 'C:/tmp' },
      // 永久挂起的 fetch：refresh() 永远不落地，hydrate 灌进去的 snap 不会被覆写
      http: { fetch: () => new Promise(() => {}) },
      process: { run: async () => ({ code: 0, stdout: '' }) },
    },
  };
}

function handlers() {
  const seen: Array<{ n: string; m: any; h: any }> = [];
  register((n: string, m: any, h: any) => {
    if (typeof m === 'function') {
      h = m;
      m = null;
    }
    seen.push({ n, m, h });
  });
  const pick = (n: string, component?: string) =>
    seen.filter((x) => x.n === n && (!component || (x.m && x.m.component === component)));
  return pick;
}

// ── 护栏本身要先被验一遍 ──
// 一个"永远返回 undefined"的校验器会让下面两条测试全绿 —— 那是假的绿。
test('校验器确实会拒绝一棵坏树（否则下面两条测试是空转的）', () => {
  const F = factorySet('desktop');
  const bad = F.Box({ flexDirection: 'row', children: [F.Text({ key: 'k', color: 'ansi:red', children: 'x' })] });
  const reason = validateTree(bad, { surface: 'desktop' });
  expect(typeof reason).toBe('string');
  expect(reason).toContain('color');

  // 同一棵树，颜色合法就该收
  const good = F.Box({ flexDirection: 'row', children: [F.Text({ key: 'k', color: 'error', children: 'x' })] });
  expect(validateTree(good, { surface: 'desktop' })).toBe(undefined);
});

// ── band ──
test('band 在 20..200 列、8 个数据态、桌面与手机上产出的树都过引擎校验', async () => {
  const pick = handlers();
  const band = pick('ui.render', 'AbovePrompt')[0];
  const start = pick('session.start')[0];
  expect(Boolean(band)).toBe(true);

  const failures: string[] = [];
  for (const state of STATES) {
    for (const surface of ['desktop', 'mobile']) {
      const { $, F } = stub$(surface, state);
      await start.h($, {}, async () => null);

      for (const cols of WIDTHS) {
        const e = { props: { bodyColumns: cols, maxRows: 24, hasSurvey: false }, surface, requestId: '' };
        // 两种情况都要过：自己是链尾（rest=null），以及前面还有别的 mod 画了一块
        for (const withRest of [false, true]) {
          const next = async () =>
            withRest ? F.Box({ flexDirection: 'column', children: [F.Text({ children: 'weather' })] }) : null;
          let tree;
          try {
            tree = await band.h($, e, next);
          } catch (err) {
            failures.push(`band ${state}/${surface}/${cols}/rest=${withRest} 抛错: ${err}`);
            continue;
          }
          const reason = validateTree(tree, { surface });
          if (reason !== undefined) failures.push(`band ${state}/${surface}/${cols}/rest=${withRest} → ${reason}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});

// ── pane ──
test('pane 在四个宽度、8 个数据态、桌面与手机上产出的树都过引擎校验', async () => {
  const pick = handlers();
  const pane = pick('ui.render', 'Pane')[0];
  const start = pick('session.start')[0];

  const failures: string[] = [];
  for (const state of STATES) {
    for (const surface of ['desktop', 'mobile']) {
      const { $ } = stub$(surface, state);
      await start.h($, {}, async () => null);
      for (const cols of [56, 74, 103, 120]) {
        const e = { props: { bodyColumns: cols, maxRows: 30 }, surface, requestId: 'runway' };
        let tree;
        try {
          tree = await pane.h($, e, async () => null);
        } catch (err) {
          failures.push(`pane ${state}/${surface}/${cols} 抛错: ${err}`);
          continue;
        }
        const reason = validateTree(tree, { surface });
        if (reason !== undefined) failures.push(`pane ${state}/${surface}/${cols} → ${reason}`);
      }
    }
  }
  expect(failures).toEqual([]);
});

// ── pane 的行宽：任何宽度下都不许有行超出可用列数 ──
//
// 这是补出来的一条：上面那条 pane 测试只跑 56/74/103/120 列，**全是宽面板**。
// 而 `$.ui.open({ columns: 78 })` 只是"请求值" —— 窄窗口、用户 Ctrl+X 拖动之后
// 都可能更窄，而面板的常态恰恰是**侧边栏**。实测 40 列时结论行（档位词 + 短语，
// 两段都是 prio 0、丢不掉）按 43 格排，超出部分会被面板边缘直接裁掉。
// 面板自己的下限是 `Math.max(30, …)`，所以从 30 列起都要立得住。
test('pane 在任何宽度下每一行都不超宽（侧边栏优先）', () => {
  const catalog = {
    slug: 'goat',
    planId: 'individual-goat',
    fiveHourFraction: 0.3,
    weeklyFraction: 0.6,
    fetchedAt: NOW,
    models: [
      { name: 'DeepSeek V4 Flash (latest)', budgetUsd: 60, costPerRequest: 0.0004, monthly: 154000, fiveHour: 46200, weekly: 92400, hasTimeOfDay: false },
      // 超长名字：名字列不该把整张表撑出面板
      { name: 'A Name Long Enough To Overrun The Column If Measured Wrong', budgetUsd: 70, costPerRequest: 0.002, monthly: 35000, fiveHour: 10500, weekly: 21000, hasTimeOfDay: true },
    ],
  };
  const diff = { added: new Set<string>(), repriced: new Set<string>() };

  const failures: string[] = [];
  for (const state of STATES) {
    const v = normalize(rawFor(state), { now: NOW });
    const pace = computePace(v, NOW);
    const tier = tierOf(v, pace);
    for (const cols of [30, 31, 32, 34, 40, 46, 50, 58, 74, 103, 120]) {
      for (const extra of [undefined, { catalog, diff }]) {
        // whatIf: 没试算过 / 试算成功 / 填了非法值 —— 三条分支都要量
        for (const whatIf of [null, 3, 0]) {
          for (const r of layoutPane(v, pace, tier, cols, NOW, state === 'stale', whatIf, extra)) {
            if (r.kind !== 'row') continue;
            const w = r.segs.reduce((a, s) => a + s.width, 0);
            if (w > cols) {
              failures.push(
                `${state} / ${cols} 列 / catalog=${Boolean(extra)} / whatIf=${whatIf} → ${w} > ${cols}`,
              );
            }
          }
        }
      }
    }
  }
  expect(failures).toEqual([]);
});
