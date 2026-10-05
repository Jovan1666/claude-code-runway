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
  fmtPct,
  landingParts,
  layoutPane,
  layoutRow,
  levelColor,
  meterParts,
  modelTableText,
  normalize,
  planInfo,
  projectWindow,
  cycleProgress,
  prettyPlanName,
  quotaColor,
  safeDailyBudget,
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

// 接口**没返回** monthlyCredits 的响应（不是 0，是字段不在）—— 实测这种响应存在
const rawForNoMonthly = () => {
  const r = raw();
  delete r.credits.credits.monthlyCredits;
  return r;
};

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
  expect(levelColor(0)).toBe('success');
  expect(levelColor(59)).toBe('success');
  expect(levelColor(60)).toBe('warning');
  expect(levelColor(84)).toBe('warning');
  expect(levelColor(85)).toBe('error');
  expect(levelColor(120)).toBe('error');
});

test('quotaColor 听节奏而不是只听填充率', () => {
  // 填充率 40% 看着安全，但会提前烧完 —— 画成绿色就是骗人。
  // 第三个参数是「还能撑几天」，不是「缺口几天」。
  expect(quotaColor(40, false, null)).toBe('success');
  expect(quotaColor(40, true, 6)).toBe('warning');
  expect(quotaColor(40, true, 2)).toBe('error');
});

test('条全程只用 █ 一种字符，靠颜色区分（混用 ▒ / ░ 会高矮不齐）', () => {
  for (const [u, p] of [[40, 68], [58, 122], [5, null], [100, 100]]) {
    const parts = landingParts(u, p, 12, 'success').parts;
    for (const part of parts) {
      expect(/^█+$/.test(part.text)).toBe(true);
    }
  }
});

test('条的颜色用主题令牌，字符集必须过引擎那一关', () => {
  // 引擎只认这个字符集：/^[#a-zA-Z0-9_().,% -]{1,40}$/
  // **冒号不在里面** —— 所以 `ansi:red` 这种写法会让整棵树被判不合法、整条 band 消失。
  // （这条测试以前是反的：它断言必须写 `ansi:` 前缀。那个断言当时就已经错了。）
  for (const pct of [10, 70, 95]) {
    for (const p of meterParts(pct, 10, levelColor(pct))) {
      if (p.color) expect(COLOR_RE.test(p.color)).toBe(true);
    }
  }
  expect(meterParts(95, 10, levelColor(95)).some((p) => p.color === 'error')).toBe(true);
});

test('条在灰阶下也读得出分界：已用段加粗，落点段不加粗', () => {
  // 三段同字符 █、唯一区别是颜色时，颜色一丢就完全读不出"到哪为止是已花"。
  const { parts } = landingParts(40, 68, 10, 'success');
  expect(parts[0].bold).toBe(true); // 已用
  expect(parts[1].bold).toBe(false); // 还将用掉
});

// ────────────────────────────────────────────────────────────
// 进度条
// ────────────────────────────────────────────────────────────

test('条用块字符画：已用是实心，空槽是暗的，总宽不变', () => {
  const parts = meterParts(50, 10, 'success');
  const total = parts.reduce((a, p) => a + p.text.length, 0);
  expect(total).toBe(10);
  expect(parts[0].text).toBe('█'.repeat(5));
  expect(parts[0].color).toBe('success');
  expect(parts[1].text).toBe('█'.repeat(5)); // 空槽也是 █，只是暗的 —— 字形一致才对得齐
  expect(parts[1].dim).toBe(true);
});

test('条在极小填充率下也至少给一格，否则 3% 和 0% 分不出来', () => {
  expect(meterParts(0, 10, 'success').length).toBe(1); // 只有空槽
  const tiny = meterParts(1, 10, 'success');
  expect(tiny[0].text).toBe('█');
  expect(tiny[0].text.length).toBe(1);
});

// ────────────────────────────────────────────────────────────
// 布局
// ────────────────────────────────────────────────────────────

test('有数据时任何宽度都画得出东西，且永不超宽', () => {
  // 用户的原话："只能看到5小时的限额看不到周限额"
  // 另一半是从反面踩出来的：放不下就整行不画，会让这一行**完全空白** ——
  // 而空白和「mod 没装」长得一模一样，用户在 Desktop Code tab 上（band 比终端窄）
  // 看到的就是一片空白，根本分不清是放不下还是没装。所以有数据就必须画点什么。
  for (const cols of [200, 160, 120, 90, 70, 58, 50, 46, 40, 26, 10, 6]) {
    const segs = layout(cols).segs;
    expect(segs.length).toBeGreaterThan(0);
    const width = segs.reduce((a, s) => a + s.width, 0) + 2 * (segs.length - 1);
    expect(width).toBeLessThanOrEqual(cols);

    const ids = segs.map((s) => s.id);
    if (ids.includes('fivel')) {
      // 画得出三个窗口时，三个必须都在 —— 谁也不会把谁挤没
      for (const id of ['fivel', 'weekl', 'monl']) {
        expect(ids).toContain(id);
      }
    } else {
      // 实在放不下才退化成只报主窗口
      expect(ids).toEqual(['monp']);
    }
  }
  // 常见宽度下要画得完整（不能因为修了溢出就把内容整个砍掉）
  for (const cols of [200, 160, 120, 90, 70, 58, 50]) {
    const ids = layout(cols).segs.map((s) => s.id);
    expect(ids).toContain('fivel');
    expect(ids).toContain('monl');
  }
  // 详情入口可以丢，三个窗口的百分比不能
  expect(layout(40).segs.map((s) => s.id)).not.toContain('detail');
  expect(layout(160).segs.map((s) => s.id)).toContain('detail');
});

test('挤不下时先丢条、再丢会员名，但三个窗口的百分比永远留着', () => {
  const v = view5h();
  const wide = ids(120, v);
  expect(wide).toContain('plan');
  expect(wide).toContain('monbar');

  // 60 列：条放不下 → 条让位，**会员名留下**
  const mid = ids(60, v);
  expect(mid).not.toContain('monbar');
  expect(mid).toContain('plan');
  expect(mid).toContain('fivel');
  expect(mid).toContain('weekl');
  expect(mid).toContain('monl');

  // 40 列：连会员名也塞不下，才轮到它让位 —— 但三个窗口一个都不能少
  const narrow = ids(40, v);
  expect(narrow).not.toContain('plan');
  expect(narrow).not.toContain('monbar');
  expect(narrow).toContain('fivel');
  expect(narrow).toContain('weekl');
  expect(narrow).toContain('monl');
  expect(narrow).toContain('fivep');
  expect(narrow).toContain('weekp');
  expect(narrow).toContain('monp');
});

test('band 上不出现「超了多少钱」—— 没有行动价值的数字不上屏', () => {
  // 用户原话："超了我又能怎么样？我用完了就是用完了呀。"
  // 想知道超多少就按 1 看明细，那里有金额和断粮时刻。
  const v = view5h();
  for (const cols of [160, 120, 90, 70, 60, 40, 30, 20]) {
    const text = layout(cols, v).segs.map((s) => s.text ?? '').join(' ');
    expect(text.includes('超 $')).toBe(false);
    expect(text).not.toContain('安全'); // 同一处旧文案
  }
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
  const { parts, over } = landingParts(40, 68, 10, 'success');
  expect(over).toBe(false);
  expect(parts[0].text).toBe('████'); // 40% × 10 格
  expect(parts[0].color).toBe('success');
  expect(parts[1].text).toBe('███'); // 4 → 7
  expect(parts[1].color).toBe('success');
  expect(parts[2].text).toBe('███');
  expect(parts[2].dim).toBe(true);
});

test('落点条：会冲过上限时余量格消失，斜纹整段变红', () => {
  const { parts, over } = landingParts(40, 121, 10, 'success');
  expect(over).toBe(true);
  // 没有余量格 —— 这是"会满出来"最直接的形状
  expect(parts.some((p) => p.dim)).toBe(false);
  // 落点那一段是红的
  const landed = parts.filter((p) => !p.dim);
  expect(landed[landed.length - 1].color).toBe('error');
});

test('落点条：算不出落点时退化成普通水平条', () => {
  const { parts, over } = landingParts(40, null, 10, 'success');
  expect(over).toBe(false);
  expect(parts.filter((p) => !p.dim).length).toBe(1);
  expect(parts.some((p) => p.dim)).toBe(true);
});

test('落点条的总宽恒等于给定格数', () => {
  for (const [u, p] of [[0, null], [5, 5], [40, 68], [57, 122], [100, 100], [99, 300]]) {
    for (const n of [6, 12, 30]) {
      const total = landingParts(u, p, n, 'success').parts.reduce((a, x) => a + x.text.length, 0);
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
      // 前景色只用主题令牌 success / warning / error（引擎的字符集不允许冒号，
      // 所以既不能写 ansi: 前缀，也不该写死 hex —— hex 不跟明暗主题走）
      if (s.color) expect(['success', 'warning', 'error']).toContain(s.color);
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
  // 标签在重构里改过名：结论行现在也说「周期末预计」，均速那行省掉了「本周期」前缀
  expect(text).toContain('均速');
  expect(text).toContain('周期末预计');
  expect(text).toContain('安全线');
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

// ────────────────────────────────────────────────────────────
// 颜色：写错一处，整条 band 消失
//
// 引擎对 color / backgroundColor / borderColor 只做一次检查：
//   typeof t === 'string' && /^[#a-zA-Z0-9_().,% -]{1,40}$/.test(t)
// 不过就判**整棵 ui.render 树**不合法，整棵丢掉、改画引擎自己的（= 空白）。
// 屏幕上没有任何提示，只在日志里留一句 "a hook returned a tree that does not validate"。
//
// 曾经这里返回 'error' —— **冒号不在那个字符集里**，于是三块内容一起消失。
// 这两条测试就是那次事故的复现，别再删。
// ────────────────────────────────────────────────────────────

const COLOR_RE = /^[#a-zA-Z0-9_().,% -]{1,40}$/;

// 把一棵渲染结果里所有 color / bg 取出来（含 meter 的各个分段）
const allColors = (node: any, out: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const x of node) allColors(x, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'color' || k === 'bg') && typeof v === 'string') out.push(v);
    else if (typeof v === 'object') allColors(v, out);
  }
  return out;
};

test('levelColor / quotaColor 只给主题令牌，不给 ansi: 前缀', () => {
  // 'error' 这种写法过不了引擎的字符集，会让整棵树被判不合法
  for (const pct of [0, 10, 59, 60, 84, 85, 100, 999]) {
    for (const c of [levelColor(pct), quotaColor(pct, false, 30), quotaColor(pct, true, 1), quotaColor(pct, true, 9)]) {
      expect(COLOR_RE.test(c)).toBe(true);
      expect(c.includes(':')).toBe(false); // 冒号 = 必然失败，单独钉一遍
    }
  }
  expect(levelColor(90)).toBe('error');
  expect(levelColor(70)).toBe('warning');
  expect(levelColor(10)).toBe('success');
});

test('band 与面板在任何宽度下产出的颜色都合法', () => {
  const cases: Array<[string, any]> = [];
  for (let cols = 20; cols <= 140; cols += 3) {
    for (const v of [view(), view5h()]) {
      const pace = computePace(v, NOW);
      cases.push([`layoutRow(${cols})`, layoutRow(v, pace, tierOf(v, pace), cols, NOW, false)]);
      cases.push([`layoutPane(${cols})`, layoutPane(v, pace, tierOf(v, pace), cols, NOW, false)]);
      cases.push([`layoutPane(${cols}, whatIf)`, layoutPane(v, pace, tierOf(v, pace), cols, NOW, false, '50')]);
    }
  }
  // 陈旧读数会走另一条取色分支（颜色被抹成 null），一并覆盖
  cases.push(['layoutRow(stale)', layoutRow(view(), computePace(view(), NOW), tierOf(view(), computePace(view(), NOW)), 100, NOW, true)]);

  const bad: string[] = [];
  for (const [label, segs] of cases) {
    for (const c of allColors(segs)) if (!COLOR_RE.test(c)) bad.push(`${label}: ${JSON.stringify(c)}`);
  }
  expect(bad).toEqual([]);
});

test('meterParts 的落点段在会爆表时用 error，而不是写死的 ansi:red', () => {
  const over = landingParts(60, 130, 20, 'success');
  expect(over.over).toBe(true);
  const colors = allColors(over.parts);
  expect(colors.length).toBeGreaterThan(0);
  for (const c of colors) expect(COLOR_RE.test(c)).toBe(true);
});

// ────────────────────────────────────────────────────────────
// 每天能花多少 / 周期进度
// ────────────────────────────────────────────────────────────

test('safeDailyBudget 把「会超」翻译成一个当天能执行的目标', () => {
  // 合成值：剩 $25、还有 20 天 → 每天不超过 $1.25 就不会超
  // （⚠️ 别从真机上抄数 —— 这个仓库在这上面栽过三次，见 README 的隐私约束）
  const now = Date.parse('2026-03-10T00:00:00.000Z');
  const end = now + 20 * 86400000;
  expect(safeDailyBudget(25, end, now)).toBe(1.25);
});

test('safeDailyBudget 剩不到一天时压到 1 天，不按半天摊（那会把目标抬成两倍）', () => {
  const now = Date.parse('2026-03-10T00:00:00.000Z');
  // 剩半天、剩 $10：按精确天数摊会得出「每天 ≤ $20」，读起来像"还能多花一倍"
  expect(safeDailyBudget(10, now + 0.5 * 86400000, now)).toBe(10);
  expect(safeDailyBudget(10, now + 2 * 3600000, now)).toBe(10);
  // 超过一天才按天摊
  expect(safeDailyBudget(10, now + 2 * 86400000, now)).toBe(5);
});

test('safeDailyBudget 在没余量 / 没有结束时刻时返回 null，不返回 0 或负数', () => {
  const now = Date.parse('2026-03-10T00:00:00.000Z');
  const end = now + 86400000;
  expect(safeDailyBudget(0, end, now)).toBe(null);
  expect(safeDailyBudget(-5, end, now)).toBe(null);
  expect(safeDailyBudget(10, null, now)).toBe(null);
  expect(safeDailyBudget(10, now - 1000, now)).toBe(null); // 周期已经结束了
  expect(safeDailyBudget(NaN, end, now)).toBe(null);
});

test('cycleProgress 给出周期过了百分之几，且不依赖采样', () => {
  const now = NOW;
  const v = view(now);
  const pace = computePace(v, now);
  // 周期 3/1–3/31，now 是 3/15 → 约 45%
  const pct = cycleProgress(pace);
  expect(pct).toBeGreaterThan(40);
  expect(pct).toBeLessThan(50);
  // 采样中（样本不足）时依然给得出来 —— 它只跟时间有关
  const early = NOW - 14 * 86400000 + 3600000;
  const earlyPace = computePace(view(early), early);
  expect(earlyPace.insufficient).toBe(true);
  expect(cycleProgress(earlyPace)).toBeGreaterThanOrEqual(0);
  expect(cycleProgress(null)).toBe(null);
});

test('周期进度是「额度用得快不快」的参照系 —— 80% vs 50% 才看得出超速', () => {
  const v = view(NOW);
  const pace = computePace(v, NOW);
  const cycle = cycleProgress(pace);
  const quota = v.monthly.percent;
  // 这两个数并排才有意义：单看一个百分比没有参照。
  // （这一条不判方向 —— 夹具里两者谁大谁小是夹具的事，不是函数的事。）
  expect(typeof cycle).toBe('number');
  expect(cycle).toBeGreaterThanOrEqual(0);
  expect(cycle).toBeLessThanOrEqual(100);
  expect(typeof quota).toBe('number');
});

test('band 开头是会员名，不是档位词', () => {
  // 用户原话："这偏紧两个字放在这毫无意义……或者你说啊，我们这是 goat 的会员"。
  // 会员名是他花钱买的那一档；档位靠**颜色**表达（颜色仍然跟着档位走）。
  const v = view5h();
  const segs = layout(120, v).segs;
  const first = segs[0];
  expect(first.id).toBe('plan');
  expect(first.text).toBe('GOAT');
  // 颜色仍然跟着档位 —— 红色会员名 = 有问题，这个信号不能丢
  expect(['success', 'warning', 'error']).toContain(first.color);
});

test('拿不到会员名时退回档位词，而不是空着', () => {
  const v = view5h();
  v.plan.name = '';
  const first = layout(120, v).segs[0];
  expect(['宽裕', '偏紧', '吃紧', '断粮', '采样中']).toContain(first.text);
});

// ────────────────────────────────────────────────────────────
// 会员名不能写死
//
// 用户的话："这些东西都是会实时变动的，你写死了肯定是没有用的。"
// `PLANS` 是一张写死的表 —— 官方加一档、或者改 id，表里就没有，面板上那一格会空着。
// ────────────────────────────────────────────────────────────

test('prettyPlanName 从接口给的 planId 推出名字，不用查表', () => {
  expect(prettyPlanName('individual-goat')).toBe('Goat');
  expect(prettyPlanName('individual-max')).toBe('Max');
  expect(prettyPlanName('individual-max-10x')).toBe('Max 10x');
  expect(prettyPlanName('teams-pro')).toBe('Pro');
  expect(prettyPlanName('individual-ultra')).toBe('Ultra');
  // 表里没有的未来档位也得有名字
  expect(prettyPlanName('individual-titan')).toBe('Titan');
  expect(prettyPlanName('')).toBe('');
  expect(prettyPlanName(null)).toBe('');
});

test('官方加一档时面板不会空白 —— 名字从实时 planId 推出来', () => {
  // 表里没有 individual-titan
  expect(planInfo('individual-titan')).toBe(null);
  const v = normalize(
    {
      credits: { credits: { monthlyCredits: 20 }, windowLimits: { limited: true,
        fiveHour: { used: 1, cap: 14, resetAt: NOW + 3600000, exceeded: false },
        weekly: { used: 2, cap: 35, resetAt: NOW + 86400000, exceeded: false } } },
      subscription: { data: { status: 'active', planId: 'individual-titan',
        currentPeriodStart: new Date(NOW - 5 * 86400000).toISOString(),
        currentPeriodEnd: new Date(NOW + 25 * 86400000).toISOString() } },
      summary: { totalCost: 10, totalCount: 100, averageCost: 0.1 },
    },
    { now: NOW },
  );
  expect(v.plan.name).toBe('Titan');

  // 表里查得到的仍然用表里那个更好看的名字（GOAT 全大写）
  const goat = normalize(raw(), { now: NOW });
  expect(goat.plan.name).toBe('GOAT');
});

test('band 开头用的就是这个名字 —— 加一档也不会空着', () => {
  const v = view5h();
  v.plan.name = 'Titan';
  const first = layout(120, v).segs[0];
  expect(first.id).toBe('plan');
  expect(first.text).toBe('Titan');
});

// ────────────────────────────────────────────────────────────
// 这两个是审计抓出来的真 bug（都用合成值复现过）
// ────────────────────────────────────────────────────────────

test('余额字段缺失 **不等于** 额度用完 —— 不能凭一个缺字段弹「额度已用尽」', () => {
  // 原来的行为：monthlyCredits 拿不到 → remaining=0 → used=total=已花 → percent 恒 100%
  // → tierOf 判「断粮」→ announce() 弹「额度已用尽 · 剩 $0.00」。
  // 一个字段没返回，就伪造出最严重的那个警报。
  const raw = rawForNoMonthly();
  const v = normalize(raw, { now: NOW });
  expect(v.monthly.unknown).toBe(true);
  expect(v.monthly.percent).toBe(null);
  expect(v.monthly.rawPercent).toBe(null);
  expect(tierOf(v, computePace(v, NOW)).word).toBe('无数据');
  expect(tierOf(v, computePace(v, NOW)).word).not.toBe('断粮');
  // 界面拿到 null 会显示「—」，不是 0% 也不是 100%
  expect(fmtPct(v.monthly.percent)).toBe('—');
});

test('余额拿得到时一切照旧 —— 这个守卫不能误伤正常数据', () => {
  const v = view();
  expect(v.monthly.unknown).toBe(false);
  expect(Number.isFinite(v.monthly.percent)).toBe(true);
});

test('接口没给窗口上限时**不给百分比** —— 拿档位表兜底算出来的数是假的', () => {
  const raw = rawForNoMonthly();
  raw.credits.windowLimits.fiveHour.cap = undefined; // 接口省略 cap
  const v = normalize(raw, { now: NOW });
  expect(v.windows.fiveHour.capKnown).toBe(false);
  expect(v.windows.fiveHour.percent).toBe(null);
  expect(fmtPct(v.windows.fiveHour.percent)).toBe('—');
  // 接口给了 cap 的就照常
  expect(v.windows.weekly.capKnown).toBe(true);
  expect(Number.isFinite(v.windows.weekly.percent)).toBe(true);
});

test('planInfo 精确匹配 —— 新档位不能被误配成老档位（那会让上限跟着错）', () => {
  expect(planInfo('individual-goat').name).toBe('GOAT');
  expect(planInfo('individual-max-10x').name).toBe('Max 10x');
  // 这些是"以已知键开头的新档位"，以前的前缀匹配会把它们套上老档位的上限
  expect(planInfo('individual-gold')).toBe(null);
  expect(planInfo('individual-go-ultra')).toBe(null);
  expect(planInfo('individual-max-10x-plus')).toBe(null);
  // 官方 planId 本来就不在表里 → null，由 prettyPlanName 出名字
  expect(planInfo('individual-max')).toBe(null);
  expect(prettyPlanName('individual-max')).toBe('Max');
});

