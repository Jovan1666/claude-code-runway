// runway · 纯函数测试
//
// 只测 lib/quota.mjs —— 那里没有 `$`，不需要起会话、登录或联网。
//   claude plugin test

import { expect, test } from 'claude-code/testing';

import { register } from '../hooks/register.mjs';
import {
  computePace,
  dispWidth,
  exhaustAtMs,
  fitSegments,
  fmtDay,
  fmtMoney,
  landingParts,
  layoutPane,
  layoutRow,
  levelColor,
  meterParts,
  normalize,
  planInfo,
  projectWindow,
  quotaColor,
  tierOf,
} from '../lib/quota.mjs';

// 一份贴近真实的原始响应：GOAT 档，30 天周期，
// 已用 $32.60，5h 窗口未启动（resetAt 为 0，是个真实的边界值）。
const PERIOD_START = '2026-03-01T00:00:00.000Z';
const PERIOD_END = '2026-03-31T00:00:00.000Z';
const NOW = Date.parse('2026-03-15T00:00:00.000Z'); // 周期正中间（第 14 天）

function raw() {
  return {
    credits: {
      credits: {
        monthlyCredits: 37.4, // 注意：这是余额，不是已花
        purchasedCredits: 0,
        freeCredits: 0,
        belowThreshold: false,
        creditThreshold: 0,
      },
      windowLimits: {
        limited: true,
        fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
        weekly: { used: 2.32, cap: 35, exceeded: false, resetAt: 0 },
      },
    },
    subscription: {
      data: {
        status: 'active',
        planId: 'individual-goat',
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
      },
    },
    summary: { totalCost: 32.6, totalCount: 4200, averageCost: 0.00776 },
  };
}

const view = (now = NOW) => normalize(raw(), { now, apiBase: 'https://api.commandcode.ai' });

// 5h 窗口已启动的版本：小条只在启动后才画，所以窄宽度降级的用例要用它
const view5h = (now = NOW) => {
  const v = view(now);
  v.windows.fiveHour.started = true;
  v.windows.fiveHour.used = 2.8;
  v.windows.fiveHour.percent = 20;
  v.windows.fiveHour.resetAt = now + 3600000;
  v.windows.fiveHour.resetsInMs = 3600000;
  return v;
};

const layout = (cols, v = view(), now = NOW) => {
  const pace = computePace(v, now);
  return { segs: layoutRow(v, pace, tierOf(v, pace), cols, now, false), pace };
};

const ids = (cols, v = view()) => layout(cols, v).segs.map((s) => s.id);

// ────────────────────────────────────────────────────────────
// 数据
// ────────────────────────────────────────────────────────────

test('planInfo 用最长前缀匹配，individual-goat 不会被 individual-go 抢走', () => {
  expect(planInfo('individual-goat').monthly).toBe(70);
  expect(planInfo('individual-goat').name).toBe('GOAT');
  expect(planInfo('individual-go').monthly).toBe(10);
  expect(planInfo('something-else')).toBe(null);
});

test('normalize 把 credits 的余额换算成已用与百分比', () => {
  const v = view();
  expect(v.monthly.total).toBe(70);
  expect(v.monthly.remaining).toBe(37.4);
  expect(Math.round(v.monthly.used * 100) / 100).toBe(32.6);
  expect(Math.round(v.monthly.percent)).toBe(47);
});

test('resetAt 为 0 时归一成 null，且窗口判为未启动', () => {
  const fh = view().windows.fiveHour;
  // 0 不是"刚重置过"，是"没有这个值"
  expect(fh.resetAt).toBe(null);
  expect(fh.started).toBe(false);
});

test('computePace 在样本不足时不给结论', () => {
  const early = NOW - 14 * 86400000 + 3 * 3600000;
  const pace = computePace(view(early), early);
  // 短样本外推会一直误报，所以宁可不给
  expect(pace.insufficient).toBe(true);
  expect(pace.runwayDays).toBe(undefined);
});

test('computePace 在耗速超出周期时判为会超支并给出缺口', () => {
  const t = Date.parse(PERIOD_START) + 5 * 86400000;
  const pace = computePace(view(t), t);
  expect(pace.willExceed).toBe(true);
  expect(pace.projectedTotal).toBeGreaterThan(70);
  expect(pace.gapDays).toBeGreaterThan(0);
});

test('tierOf 按"还能撑多久"分档，余量为零时直接断粮', () => {
  const v = view();
  const wide = { insufficient: false, willExceed: false };
  expect(tierOf(v, wide).word).toBe('宽裕');
  // 严重度看 runwayDays（还能撑几天），不是 gapDays（比周期末早几天烧完）。
  // 用 gapDays 是反向的：早 13 天烧完比早 1 天烧完严重得多，
  // 但旧判据会给前者「偏紧/黄」、后者「吃紧/红」—— 颜色与旁边的数字对着干。
  expect(tierOf(v, { insufficient: false, willExceed: true, runwayDays: 6 }).word).toBe('偏紧');
  expect(tierOf(v, { insufficient: false, willExceed: true, runwayDays: 1 }).word).toBe('吃紧');
  expect(tierOf(v, { insufficient: true }).word).toBe('采样中');
  const none = view();
  none.monthly.remaining = 0;
  expect(tierOf(none, wide).word).toBe('断粮');
});

// ────────────────────────────────────────────────────────────
// 取色
// ────────────────────────────────────────────────────────────

test('levelColor 按填充率分三档', () => {
  expect(levelColor(0)).toBe('ansi:green');
  expect(levelColor(59)).toBe('ansi:green');
  expect(levelColor(60)).toBe('ansi:yellow');
  expect(levelColor(84)).toBe('ansi:yellow');
  expect(levelColor(85)).toBe('ansi:red');
  expect(levelColor(120)).toBe('ansi:red');
});

test('quotaColor 听节奏而不是只听填充率', () => {
  // 填充率 40% 看着安全，但会提前烧完 —— 画成绿色就是骗人。
  // 第三个参数是「还能撑几天」，不是「缺口几天」。
  expect(quotaColor(40, false, null)).toBe('ansi:green');
  expect(quotaColor(40, true, 6)).toBe('ansi:yellow');
  expect(quotaColor(40, true, 2)).toBe('ansi:red');
});

test('条全程只用 █ 一种字符，靠颜色区分（混用 ▒ / ░ 会高矮不齐）', () => {
  for (const [u, p] of [[40, 68], [58, 122], [5, null], [100, 100]]) {
    const parts = landingParts(u, p, 12, 'ansi:green').parts;
    for (const part of parts) {
      expect(/^█+$/.test(part.text)).toBe(true);
    }
  }
});

test('条的颜色必须写成 ansi: 前缀，裸色名会被引擎当主题键丢掉', () => {
  // color 是裸 string、没有枚举：引擎只在 rgb( / # / ansi256( / ansi: 开头时原样用，
  // 否则当主题键查表，查不到返回 undefined —— 不报错、不抛异常，只是**完全没有颜色**。
  // 主题里有 success/warning/error/rate_limit_empty，没有 green/yellow/red，
  // 所以以前整根条是一点颜色都没有的。
  for (const pct of [10, 70, 95]) {
    for (const p of meterParts(pct, 10, levelColor(pct))) {
      if (p.color) expect(p.color).toMatch(/^ansi:(green|yellow|red)$/);
    }
  }
});

test('条在灰阶下也读得出分界：已用段加粗，落点段不加粗', () => {
  // 三段同字符 █、唯一区别是颜色时，颜色一丢就完全读不出"到哪为止是已花"。
  const { parts } = landingParts(40, 68, 10, 'ansi:green');
  expect(parts[0].bold).toBe(true); // 已用
  expect(parts[1].bold).toBe(false); // 还将用掉
});

// ────────────────────────────────────────────────────────────
// 进度条
// ────────────────────────────────────────────────────────────

test('条用块字符画：已用是实心，空槽是暗的，总宽不变', () => {
  const parts = meterParts(50, 10, 'ansi:green');
  const total = parts.reduce((a, p) => a + p.text.length, 0);
  expect(total).toBe(10);
  expect(parts[0].text).toBe('█'.repeat(5));
  expect(parts[0].color).toBe('ansi:green');
  expect(parts[1].text).toBe('█'.repeat(5)); // 空槽也是 █，只是暗的 —— 字形一致才对得齐
  expect(parts[1].dim).toBe(true);
});

test('条在极小填充率下也至少给一格，否则 3% 和 0% 分不出来', () => {
  expect(meterParts(0, 10, 'ansi:green').length).toBe(1); // 只有空槽
  const tiny = meterParts(1, 10, 'ansi:green');
  expect(tiny[0].text).toBe('█');
  expect(tiny[0].text.length).toBe(1);
});

// ────────────────────────────────────────────────────────────
// 布局
// ────────────────────────────────────────────────────────────

test('三个窗口要么一起完整出现，要么整行不画（不再交回超宽内容）', () => {
  // 用户的原话："只能看到5小时的限额看不到周限额"
  for (const cols of [200, 160, 120, 90, 70, 58, 50, 46, 40, 26, 10]) {
    const segs = layout(cols).segs;
    if (!segs.length) continue; // 装不下就整行不画 —— 好过折行把最右边的「月」切掉
    const width = segs.reduce((a, s) => a + s.width, 0) + 2 * (segs.length - 1);
    expect(width).toBeLessThanOrEqual(cols);
    for (const id of ['fivel', 'weekl', 'monl', 'detail']) {
      expect(segs.map((s) => s.id)).toContain(id);
    }
  }
  // 常见宽度下必须画得出来（不能因为修了溢出就把这一行整个弄没）
  for (const cols of [200, 160, 120, 90, 70, 58, 50]) {
    expect(layout(cols).segs.length).toBeGreaterThan(0);
  }
});

test('挤不下时先丢落点结论、再丢条，但三个窗口的百分比永远留着', () => {
  const v = view5h();
  const wide = ids(160, v);
  expect(wide).toContain('foot');
  expect(wide).toContain('monbar');

  const narrow = ids(50, v);
  expect(narrow).not.toContain('foot');
  expect(narrow).not.toContain('monbar');
  // 但三个窗口都还在 —— 这正是之前被挤没的东西
  expect(narrow).toContain('fivel');
  expect(narrow).toContain('weekl');
  expect(narrow).toContain('monl');
  expect(narrow).toContain('fivep');
  expect(narrow).toContain('weekp');
  expect(narrow).toContain('monp');
});

test('三条宽度相同、一起伸缩 —— 不会有一条独大挤掉别人', () => {
  const v = view5h();
  const barW = (cols, id) => {
    const s = layout(cols, v).segs.find((x) => x.id === id);
    return s ? s.width : 0;
  };
  for (const cols of [160, 120, 90, 70]) {
    expect(barW(cols, 'fivebar')).toBe(barW(cols, 'monbar'));
    expect(barW(cols, 'weekbar')).toBe(barW(cols, 'monbar'));
  }
  // 越窄越短
  expect(barW(70, 'monbar')).toBeLessThan(barW(120, 'monbar'));
  // 要么完整画出来，要么干脆不画 —— 不留一条看不出的残条
  for (const c of [160, 120, 90, 70, 50, 30]) {
    const w = barW(c, 'monbar');
    expect(w === 0 || w >= 4).toBe(true);
  }
});

// ────────────────────────────────────────────────────────────
// 落点条
// ────────────────────────────────────────────────────────────

test('落点条：实心=已用，斜纹=还将用掉，余量格=会剩下的', () => {
  // 用了 40%，预计走到 68% —— 三区齐全
  const { parts, over } = landingParts(40, 68, 10, 'ansi:green');
  expect(over).toBe(false);
  expect(parts[0].text).toBe('████'); // 40% × 10 格
  expect(parts[0].color).toBe('ansi:green');
  expect(parts[1].text).toBe('███'); // 4 → 7
  expect(parts[1].color).toBe('ansi:green');
  expect(parts[2].text).toBe('███');
  expect(parts[2].dim).toBe(true);
});

test('落点条：会冲过上限时余量格消失，斜纹整段变红', () => {
  const { parts, over } = landingParts(40, 121, 10, 'ansi:green');
  expect(over).toBe(true);
  // 没有余量格 —— 这是"会满出来"最直接的形状
  expect(parts.some((p) => p.dim)).toBe(false);
  // 落点那一段是红的
  const landed = parts.filter((p) => !p.dim);
  expect(landed[landed.length - 1].color).toBe('ansi:red');
});

test('落点条：算不出落点时退化成普通水平条', () => {
  const { parts, over } = landingParts(40, null, 10, 'ansi:green');
  expect(over).toBe(false);
  expect(parts.filter((p) => !p.dim).length).toBe(1);
  expect(parts.some((p) => p.dim)).toBe(true);
});

test('落点条的总宽恒等于给定格数', () => {
  for (const [u, p] of [[0, null], [5, 5], [40, 68], [57, 122], [100, 100], [99, 300]]) {
    for (const n of [6, 12, 30]) {
      const total = landingParts(u, p, n, 'ansi:green').parts.reduce((a, x) => a + x.text.length, 0);
      expect(total).toBe(n);
    }
  }
});

test('projectWindow 用重置时刻倒推窗口起点算速率', () => {
  // 周窗口 7 天，还有 5 天重置 → 已经跑了 2 天，花了 $7 → 7 天会花 $24.5
  const spec = { used: 7, cap: 35, started: true, resetAt: NOW + 5 * 86400000 };
  const pr = projectWindow(spec, 7 * 86400000, NOW);
  expect(pr).not.toBe(null);
  expect(Math.round(pr.projectedPct)).toBe(70);
  expect(pr.willExceed).toBe(false);
});

test('projectWindow 在窗口刚开场时不给结论（突发外推是噪声）', () => {
  // 实测案例：5h 窗口跑了 16 分钟、用了 7.4%，按 5% 门槛刚好放行，
  // 外推出来是 139% —— 纯噪声。20% 门槛（1 小时）把它挡住。
  const spec = { used: 1.03, cap: 14, started: true, resetAt: NOW + 284 * 60000 };
  expect(projectWindow(spec, 5 * 3600000, NOW)).toBe(null);
  // 跑满 1 小时以上才给结论
  const later = { used: 3.0, cap: 14, started: true, resetAt: NOW + 3 * 3600000 };
  expect(projectWindow(later, 5 * 3600000, NOW)).not.toBe(null);
});

test('projectWindow 对未启动的窗口返回 null', () => {
  const spec = { used: 0, cap: 14, started: false, resetAt: null };
  expect(projectWindow(spec, 5 * 3600000, NOW)).toBe(null);
});

// ────────────────────────────────────────────────────────────
// 断粮时刻与试算
// ────────────────────────────────────────────────────────────

test('exhaustAtMs 把"还剩多久"换成绝对时刻', () => {
  const at = exhaustAtMs(10, 2, NOW);
  expect(at).toBe(NOW + 5 * 86400000);
  expect(exhaustAtMs(0, 2, NOW)).toBe(null);
  expect(exhaustAtMs(10, 0, NOW)).toBe(null);
});

test('fmtDay 输出 MM/DD HH:mm', () => {
  const ms = new Date(2026, 5, 7, 4, 5).getTime();
  expect(fmtDay(ms)).toBe('06/07 04:05');
  expect(fmtDay(null)).toBe('—');
});

test('试算器接受一个日花费，算出新的断粮时刻', () => {
  const v = view();
  const pace = computePace(v, NOW);
  const rows = (whatIf) => layoutPane(v, pace, tierOf(v, pace), 76, NOW, false, whatIf);
  const flat = (whatIf) =>
    rows(whatIf)
      .filter((r) => r.kind === 'row')
      .flatMap((r) => r.segs)
      .map((s) => s.text || s.label || '')
      .join(' ');

  // 没有输入时不显示结论
  expect(flat(null)).not.toContain('这样会烧到');
  // 输入后出现结论，并且提到"撑得到周期末"或"断"
  const out = flat('1.88');
  expect(out).toContain('这样会烧到');
  // 输入框本身是一个 input 段
  const segs = rows(null).flatMap((r) => (r.kind === 'row' ? r.segs : []));
  expect(segs.some((s) => s.kind === 'input')).toBe(true);
});

test('每一段都带完整形状，渲染器不必兜底', () => {
  const { segs } = layout(160);
  for (const s of segs) {
    expect(typeof s.id).toBe('string');
    expect(typeof s.width).toBe('number');
    if (s.kind === 'text') {
      expect(typeof s.text).toBe('string');
      // 前景色只能是原始 ANSI 名或主题令牌，不能是 hex（写错整行消失）
      if (s.color) expect(['ansi:green', 'ansi:yellow', 'ansi:red', 'success', 'warning', 'error']).toContain(s.color);
    }
    if (s.kind === 'meter') expect(Array.isArray(s.parts)).toBe(true);
    if (s.kind === 'button') {
      expect(typeof s.hotkey).toBe('string');
      expect(typeof s.label).toBe('string');
    }
  }
});

test('fitSegments 从不删除 prio 为 0 的段', () => {
  const kept = fitSegments(
    [
      { id: 'a', prio: 0, width: 40 },
      { id: 'b', prio: 9, width: 40 },
    ],
    10,
  );
  expect(kept.map((s) => s.id)).toEqual(['a']);
});

// ────────────────────────────────────────────────────────────
// 面板
// ────────────────────────────────────────────────────────────

test('面板的月额度行显示 total，不是 cap（月窗口没有 cap 字段）', () => {
  const rows = layoutPane(view(), computePace(view(), NOW), tierOf(view(), computePace(view(), NOW)), 58, NOW, false);
  const flat = rows
    .filter((r) => r.kind === 'row')
    .flatMap((r) => r.segs)
    .map((s) => s.text || '')
    .join(' ');
  // 这就是线上那个 $39.52 / — 的 bug：读错字段名
  expect(flat).toContain('$70.00');
  expect(flat).not.toContain('—');
});

test('面板含三个窗口、节奏预测与两个按钮', () => {
  const v = view();
  const pace = computePace(v, NOW);
  const rows = layoutPane(v, pace, tierOf(v, pace), 58, NOW, false);
  const flat = rows.filter((r) => r.kind === 'row').flatMap((r) => r.segs);
  const text = flat.map((s) => s.text || s.label || '').join(' ');
  const btns = flat.filter((s) => s.kind === 'button').map((s) => s.id);

  expect(text).toContain('月');
  expect(text).toContain('5h');
  expect(text).toContain('周');
  expect(text).toContain('本周期均速');
  expect(text).toContain('周期末预计');
  expect(btns).toEqual(['refresh', 'copy']);
});

test('5h 未启动时不画 0% 的条，而是明说未启动', () => {
  const v = view();
  const pace = computePace(v, NOW);
  const text = layoutPane(v, pace, tierOf(v, pace), 58, NOW, false)
    .filter((r) => r.kind === 'row')
    .flatMap((r) => r.segs)
    .map((s) => s.text || '')
    .join(' ');
  expect(text).toContain('未启动');
});

// ────────────────────────────────────────────────────────────
// 杂项与注册
// ────────────────────────────────────────────────────────────

test('fmtMoney 在 $0.003 量级不会压成 $0.00', () => {
  expect(fmtMoney(0.0035)).toBe('$0.0035');
  expect(fmtMoney(0.698)).toBe('$0.698');
  expect(fmtMoney(45.67)).toBe('$45.67');
  expect(fmtMoney(null)).toBe('—');
});

test('dispWidth 把中日韩字符记两格，块字符记一格', () => {
  expect(dispWidth('偏紧')).toBe(4);
  expect(dispWidth('12d')).toBe(3);
  expect(dispWidth('█│▓░')).toBe(4);
});

test('session.start 会恢复 marks：看过明细之后不再弹引导 toast', async () => {
  // 这条用例是为一个真实的回归补的：hydrate 里引用了没 import 的 HERO_ORDER
  // 和一个从没声明过的 hero，抛出的 ReferenceError 被紧挨着的空 catch 吞掉，
  // 于是 marks 从来没有被恢复过一次 —— 引导 toast 每个会话都弹，
  // 跨档提醒也每个进程重报一次。原来的测试只断言"注册了哪些事件"、
  // 从不真的执行 handler，所以完全没兜住。
  const toasts: string[] = [];
  const handlers = new Map<string, Function>();
  const on = (name: string, matcher: unknown, handler?: Function) => {
    if (typeof matcher === 'function') {
      handler = matcher;
      matcher = null;
    }
    handlers.set(name + JSON.stringify(matcher ?? null), handler as Function);
    return { catch: () => ({}) };
  };
  register(on as never);

  const start = handlers.get('session.startnull');
  expect(typeof start).toBe('function');

  const store = new Map<string, unknown>([
    ['runway.marks', { announcedCycle: 'c1', announcedTier: '偏紧', sawDetail: true }],
  ]);
  const $ = {
    clock: { every: () => ({ cancel: () => {} }) },
    store: { get: async (k: string) => store.get(k) ?? null, set: async () => {} },
    ui: { toast: (t: string) => void toasts.push(t), invalidate: () => {} },
    command: { register: async () => {} },
    env: { get: async () => undefined },
  };

  await start($, {}, async () => null);

  // 已经看过明细 → 那条一次性的引导提示不该再出现
  expect(toasts).toEqual([]);
});

test('register 只注册预期的事件，band 与面板各一个渲染钩子', () => {
  const seen = [];
  const on = (name, matcher) => {
    seen.push(matcher === undefined ? name : name + JSON.stringify(matcher));
    return { catch: () => ({}) };
  };

  register(on);

  expect(seen.filter((s) => s.startsWith('ui.render'))).toEqual([
    'ui.render{"component":"AbovePrompt"}',
    'ui.render{"component":"Pane"}',
  ]);
  const names = seen.map((s) => s.replace(/undefined$/, '').replace(/\{.*$/, ''));
  expect(names).toEqual([
    'session.start',
    'turn.complete',
    'command.run',
    'ui.render',
    'ui.render',
    'session.end',
  ]);
});
