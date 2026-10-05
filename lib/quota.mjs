// runway · 纯函数层
//
// 这个文件里不出现 `$`。所有函数只吃普通数据、吐普通数据，
// 所以 hooks 模块可以 import 它，`claude plugin test` 也能直接测它。
// （mods 的静态检查只允许把 `$` 传给同一文件里顶层声明的函数，
//   跨文件传 `$` 会验证失败 —— 把纯逻辑分出来正好避开这条约束。）

// ────────────────────────────────────────────────────────────
// 套餐上限表（照抄 cc-usage.mjs 的 PLANS，值来自 Command Code 公开档位）
// 接口没返回 cap 时用它兜底。
// ────────────────────────────────────────────────────────────
export const PLANS = {
  'individual-go': { name: 'Go', monthly: 10, fiveHour: 3, weekly: 6 },
  'individual-goat': { name: 'GOAT', monthly: 70, fiveHour: 14, weekly: 35 },
  'individual-pro': { name: 'Pro', monthly: 80, fiveHour: 16, weekly: 40 },
  'individual-max-10x': { name: 'Max 10x', monthly: 150, fiveHour: 45, weekly: 90 },
  'individual-max-20x': { name: 'Max 20x', monthly: 300, fiveHour: 90, weekly: 180 },
  'teams-pro': { name: 'Team Pro', monthly: 40, fiveHour: 12, weekly: 24 },
};

export function planInfo(planId) {
  if (!planId || typeof planId !== 'string') return null;
  const norm = planId.toLowerCase().replace(/_/g, '-');
  // 长键优先，避免 'individual-go' 抢先匹配掉 'individual-goat'
  const key = Object.keys(PLANS)
    .sort((a, b) => b.length - a.length)
    .find((k) => norm.startsWith(k));
  return key ? { id: planId, ...PLANS[key] } : null;
}

// ────────────────────────────────────────────────────────────
// 显示宽度：CJK 与全角记 2 格，其余记 1 格。
// 块字符（█▓░│ 等 U+25xx / U+2500）在这里按 1 格算 —— 与 token-weather
// 的图表同一处理方式，在同一个渲染器里表现一致。
// ────────────────────────────────────────────────────────────
export function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide =
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        cp === 0x2329 ||
        cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6));
    w += wide ? 2 : 1;
  }
  return w;
}

// ────────────────────────────────────────────────────────────
// FNV-1a。只用来判断"这份缓存属于哪个账号"，不是加密用途。
// 照抄 cc-usage.mjs。
// ────────────────────────────────────────────────────────────
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ────────────────────────────────────────────────────────────
// 凭据的信任边界。
//
// 配置文件里的 `api.baseUrl` 是**不可信输入** —— 这个项目的用法就是
// "别人给你一份 provider 配置模板、你把 key 填进去"，所以那个文件里的
// 地址不能当作可信来源。而我们会把 API key 当 Bearer 头打到这个地址上。
//
// 之前这里只做 `/commandcode\.ai/i` 子串匹配，实测这些都会命中：
//   https://evil.tld/commandcode.ai/provider/v1     → 配置里的任意域名
//   https://commandcode.ai.evil.tld/provider/v1     → 抢注的近似域名
//   https://evil.tld/x?u=commandcode.ai             → 参数里带一下就够
//   http://api.commandcode.ai/provider/v1           → 明文，key 裸奔
// 等于一个"把 key 寄给配置文件作者"的通道，且不需要对方能读我们的文件。
//
// 所以命中条件收紧成：**精确主机 + 必须 https**。
// ────────────────────────────────────────────────────────────
export const ALLOWED_HOSTS = new Set(['api.commandcode.ai']);

export function hostOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function isTrustedBase(url) {
  const host = hostOf(url);
  return host !== null && ALLOWED_HOSTS.has(host);
}

// 配置文件里的 key 也要过形状检查。以前这里只要求"是个非空字符串"，
// 于是配置里任何一个字符串都能让本模块发出带 Bearer 的请求。
// 用宽松但真实的形状（可打印、无空白、20 字符以上），
// 而不是要求 user_ / cc_ 前缀 —— 前缀是接口的实现细节，用它会把合法 key 挡在门外。
export function looksLikeKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.\-]{20,256}$/.test(value.trim());
}

// ────────────────────────────────────────────────────────────
// 在一份配置对象里递归找 Command Code 的凭据。
// 命中条件：同一个节点上既有 access.apiKey 又有**可信的** api.baseUrl。
// 照抄 cc-usage.mjs 的 scanForProviderKey（深度上限 8）。
// ────────────────────────────────────────────────────────────
export function scanForProviderKey(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = scanForProviderKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const key = node.access && node.access.apiKey;
  const url = node.api && node.api.baseUrl;
  if (looksLikeKey(key) && isTrustedBase(url)) {
    return { apiKey: key.trim(), baseUrl: url.trim() };
  }
  for (const value of Object.values(node)) {
    const hit = scanForProviderKey(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// 不可信字符串 → 单行可见文本。
//
// planId 来自接口响应，之前它被原样写进面板和"复制快照"的文本里 ——
// 而快照的设计目的就是给人贴到 issue / 群里。于是响应里一个带换行的
// planId 就能伪造出额外的行（例如伪造一行"凭证 user_xxx"），
// ANSI/OSC 序列还能改窗口标题或覆写同一行。
// 摈弃控制字符，并限长。
// ────────────────────────────────────────────────────────────
export function safeLabel(value, max = 32) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, max);
}


// ────────────────────────────────────────────────────────────
// 归一化：把三个端点的原始响应算成界面要用的数。
//
// ⚠ 两个易混字段（名字同源、语义相反）：
//   credits.credits.monthlyCredits  = 月度**余额**
//   summary.totalMonthlyCredits     = 月度**已花**
// 这里用前者，后者不碰。
// ────────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function windowOf(spec, fallbackCap, now) {
  if (!spec || typeof spec !== 'object') return null;
  const used = Math.max(0, num(spec.used));
  const cap = num(spec.cap) || fallbackCap || 0;
  const resetAt = num(spec.resetAt) || null; // 0 归一成 null：实测接口会给 0
  return {
    used,
    cap,
    percent: cap > 0 ? Math.min((used / cap) * 100, 100) : 0,
    rawPercent: cap > 0 ? (used / cap) * 100 : 0,
    remaining: Math.max(0, cap - used),
    resetAt,
    resetsInMs: resetAt !== null ? Math.max(0, resetAt - now) : null,
    exceeded: Boolean(spec.exceeded),
    // 实测存在 started:true 但 used:0 的合法态，两个条件都要看
    started: used > 0 || (resetAt !== null && resetAt > now),
  };
}

export function normalize(raw, meta) {
  const now = meta.now;
  const sub = raw.subscription && raw.subscription.data ? raw.subscription.data : null;
  const plan = planInfo(sub && sub.planId);
  const c = (raw.credits && raw.credits.credits) || {};
  const wl = (raw.credits && raw.credits.windowLimits) || null;
  const sm = raw.summary || {};

  // 字段缺失 ≠ 余额为 0。以前这里把缺失的 monthlyCredits 直接当成 0，
  // 于是 totalPool 取档位上限、monthlyUsed = 上限 → 100% 已用、remaining 0，
  // tierOf 判「断粮」，announce() 还会弹一条「额度已用尽 · 剩 $0.00」。
  // 一个字段没返回就能伪造出"额度花光"的警报。
  const hasMonthly = Number.isFinite(Number(c.monthlyCredits));
  const monthlyRemaining = hasMonthly ? Math.max(0, num(c.monthlyCredits)) : 0;
  const purchasedRemaining = Math.max(0, num(c.purchasedCredits));
  const freeRemaining = Math.max(0, num(c.freeCredits));
  const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining;
  const totalSpent = Math.max(0, num(sm.totalCost));

  const active = Boolean(sub && sub.status === 'active');
  const planMonthly = active && plan ? plan.monthly : null;
  // 余额缺失时不能拿"档位上限 − 0"当已用；退回按 summary 已花统计的口径。
  const totalPool =
    planMonthly !== null && hasMonthly
      ? Math.max(planMonthly, monthlyRemaining) + purchasedRemaining + freeRemaining
      : totalSpent + totalRemaining;
  const monthlyUsed = Math.max(0, totalPool - totalRemaining);

  // Date.parse 对不可解析的字符串返回 NaN，而 NaN !== null ——
  // 于是 Math.max(0, NaN) 会把「周期还剩 NaN 天」直接画到屏幕上。
  const parseAt = (s) => {
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const periodStartMs = parseAt(sub && sub.currentPeriodStart);
  const periodEndMs = parseAt(sub && sub.currentPeriodEnd);

  return {
    fetchedAt: now,
    plan: {
      id: plan ? plan.id : null,
      // planId 来自接口响应，会被写进面板和"复制快照"（而快照的设计目的是给人贴出去）。
      // 不剥控制字符的话，一个带换行的 planId 就能在快照里伪造出额外的行。
      name: plan ? plan.name : sub ? safeLabel(sub.planId) : '',
      status: sub ? sub.status : null,
      active,
      monthlyTotal: planMonthly,
      periodStartMs,
      periodEndMs,
      periodDays:
        periodStartMs && periodEndMs ? Math.max(0, (periodEndMs - periodStartMs) / 86400000) : null,
      daysLeft:
        periodEndMs !== null ? Math.max(0, Math.ceil((periodEndMs - now) / 86400000)) : null,
    },
    monthly: {
      used: monthlyUsed,
      total: totalPool,
      remaining: totalRemaining,
      percent: totalPool > 0 ? Math.min((monthlyUsed / totalPool) * 100, 100) : 0,
      rawPercent: totalPool > 0 ? (monthlyUsed / totalPool) * 100 : 0,
      belowThreshold: Boolean(c.belowThreshold),
    },
    windows: {
      limited: wl ? Boolean(wl.limited) : null,
      fiveHour: windowOf(wl && wl.fiveHour, plan && plan.fiveHour, now),
      weekly: windowOf(wl && wl.weekly, plan && plan.weekly, now),
    },
    avgCostPerRequest: num(sm.averageCost) || null,
    requestCount: num(sm.totalCount) || null,
  };
}

// ────────────────────────────────────────────────────────────
// 节奏外推：把"用了多少 %"翻译成"还剩多久"。
//
// 样本门控照抄 cc-usage.mjs 的 minSample（10 分钟与 5% 周期取大者）：
// 短样本外推几乎一直在报警 —— 一次正常爆发在 25 分钟处会被外推成 140%。
// 门控不过就不给结论，界面显示"采样中"。
// ────────────────────────────────────────────────────────────
export function computePace(v, now) {
  const startMs = v.plan.periodStartMs;
  const endMs = v.plan.periodEndMs;
  if (!startMs || !endMs || endMs <= startMs) return null;
  const totalMs = endMs - startMs;
  const elapsedMs = Math.min(now, endMs) - startMs;
  const minSample = Math.max(10 * 60_000, totalMs * 0.05);
  const daysLeftMs = Math.max(0, endMs - now);

  if (elapsedMs < minSample || !(v.monthly.used > 0)) {
    return {
      insufficient: true,
      elapsedMs,
      totalMs,
      sampleDays: elapsedMs / 86400000,
      daysLeftDays: daysLeftMs / 86400000,
    };
  }

  const perMs = v.monthly.used / elapsedMs;
  const remainingMs = v.monthly.remaining / perMs;
  return {
    insufficient: false,
    elapsedMs,
    totalMs,
    sampleDays: elapsedMs / 86400000,
    perDay: perMs * 86400000,
    runwayDays: remainingMs / 86400000,
    daysLeftDays: daysLeftMs / 86400000,
    // > 0 表示会在周期结束前耗尽
    gapDays: (daysLeftMs - remainingMs) / 86400000,
    projectedTotal: perMs * totalMs,
    willExceed: perMs * totalMs > v.monthly.total,
  };
}

// ────────────────────────────────────────────────────────────
// 档位。图标取 Geometric Shapes 块（单宽），不用 emoji。
// color 一律用主题令牌，明暗主题都会自适应。
// ────────────────────────────────────────────────────────────
export function tierOf(v, pace) {
  if (v.monthly.remaining <= 0 || v.monthly.percent >= 100) {
    return { icon: '●', word: '断粮', color: 'error', bold: true };
  }
  if (!pace || pace.insufficient) {
    return { icon: '◌', word: '采样中', color: null, bold: false };
  }
  if (!pace.willExceed) {
    return { icon: '○', word: '宽裕', color: 'success', bold: false };
  }
  // 严重度看「还能撑多久」，不看「缺口多少天」。
  // 判据原来是 gapDays <= 3 → 吃紧，方向是反的：gapDays 是"比周期结束早多少天烧完"，
  // 越大越糟。实测它给出自相矛盾的画面 ——「吃紧」+红+加粗 配"还能撑 15d，早 1.2d 烧完"，
  // 而「偏紧」+黄 配"还能撑 2.3d，早 13.7d 烧完"。颜色和紧挨着的数字对着干。
  if (pace.runwayDays <= 3) {
    return { icon: '◕', word: '吃紧', color: 'error', bold: true };
  }
  return { icon: '◑', word: '偏紧', color: 'warning', bold: false };
}

// ────────────────────────────────────────────────────────────
// 进度条：用**背景色实心块**画，不是块字符。
//
// 为什么换掉 █▓░：它们是 U+2588 块字符，宽度是 East-Asian Ambiguous，
// 取决于字体按单宽还是双宽渲染；而且多个块字符挨在一起时，
// 有些字体会在每个字形之间留缝，整根条糊成一片灰。
// 背景色涂在空格上则与字体无关 —— 任何字体下都是实心矩形。
//
// 取色用原始的 ANSI 色名（green/yellow/red）而不是主题令牌：
// success/warning/error 是为**文字**调的前景色，天生柔和，
// 当背景用永远不够鲜明。轨道用主题令牌 rate_limit_empty ——
// 它就是 /usage 那根用量条的空槽色，明暗主题都合适。
// ────────────────────────────────────────────────────────────
// ⚠ 必须写成 `ansi:red` 这种形式。
// color / backgroundColor 在类型里是裸 string、没有枚举，引擎的解析规则是：
//   rgb( / # / ansi256( / ansi: 开头 → 原样用；否则当**主题键**查表，查不到就返回 undefined。
// 而主题里只有 success / warning / error / rate_limit_empty / inactive 这些键，
// **没有** green / yellow / red。所以以前返回裸 'red' 的后果是：
// 不报错、不抛异常，只是**整根条一点颜色都没有** —— 这个项目最核心的
// "一根条一个颜色 = 安全；出现红色 = 会爆表" 从头到尾没有生效过。
export function levelColor(pct) {
  if (pct >= 85) return 'ansi:red';
  if (pct >= 60) return 'ansi:yellow';
  return 'ansi:green';
}

// 月额度条的取色：**听节奏，不是只听填充率**。
// 填充率 56% 看着很安全，但如果按当前速度会提前烧完，
// 画成绿色就是骗人 —— 绿色配旁边红色的「还能撑 11d」自相矛盾。
export function quotaColor(pct, short, runwayDays) {
  if (short) return runwayDays <= 3 ? 'ansi:red' : 'ansi:yellow';
  return levelColor(pct);
}

export function meterParts(pct, cells, fill) {
  return landingParts(pct, null, cells, fill).parts;
}

// ────────────────────────────────────────────────────────────
// 落点条：一根条讲完 过去 / 未来 / 余量。
//
//   █  已经花掉的
//   ▒  按当前速度**还将花掉**的
//   ░  照这个速度**会剩下来的**
//
// 会不会爆表不用读字：**右半截变红 = 会冲过上限**，
// 余量格消失也说明同一件事。轴固定 0→100%，不画刻度 —— 条的末端就是上限。
//
// projPct 传 null 就退化成普通水平条（那个窗口样本不足、算不出落点时）。
// ────────────────────────────────────────────────────────────
export function landingParts(usedPct, projPct, cells, color) {
  const n = Math.max(0, Math.floor(cells));
  // 0 格直接返回空。否则下面"极小填充率也至少给一格"那条规则会在 n=0 时
  // 吐出 1 格 —— 破坏"总宽恒等于给定格数"这条不变量（fuzz 里 81 例）。
  if (n <= 0) return { parts: [], over: false };
  const u = Math.min(Math.max(Number(usedPct) || 0, 0), 100);
  const p = projPct == null ? u : Math.min(Math.max(Number(projPct) || 0, u), 999);
  const over = p > 100;
  const usedCells = u <= 0 ? 0 : Math.max(1, Math.round((u / 100) * n));
  const projCells = Math.max(usedCells, Math.min(n, Math.round((Math.min(p, 100) / 100) * n)));

  // **全程只用 █，靠颜色区分**，不混用 █ / ▒ / ░ 三种密度字符。
  // 混用的后果：100% / 50% / 25% 三种"重量"拼在一起，同一根条看起来像三种东西，
  // 高矮粗细都对不齐 —— 这是用户直接指出来的。
  // 现在实心段 / 落点段 / 余量段是同一个字形，只有颜色不同，天然对齐。
  const parts = [];
  // 已用段加粗、落点段不加粗 —— 这样即使颜色全丢了（灰阶终端、色盲、
  // 主题把 ansi 色映射成同色），"到哪为止是已经花掉的"依然读得出来。
  // 以前两段的 bold / dim 完全相同，唯一区别就是颜色。
  if (usedCells > 0) parts.push({ text: '█'.repeat(usedCells), color, bold: true, dim: false });
  const added = projCells - usedCells;
  if (added > 0) {
    // 会冲过上限 → 落点段整段变红；撑得住 → 和已用段同色，合成一根完整的条
    parts.push({ text: '█'.repeat(added), color: over ? 'ansi:red' : color, bold: false, dim: false });
  }
  if (n - projCells > 0) {
    parts.push({ text: '█'.repeat(n - projCells), color: null, bold: false, dim: true });
  }
  return { parts, over };
}

// ────────────────────────────────────────────────────────────
// 「还剩 11 天」是个长度，可以拖；「10/26 04:00」是个时刻，不能。
// 人会自动把时刻跟日历上别的事对照，所以它比天数扎心得多。
// ────────────────────────────────────────────────────────────
export function exhaustAtMs(remaining, dailyRate, now) {
  if (!(remaining > 0) || !(dailyRate > 0)) return null;
  return now + (remaining / dailyRate) * 86400000;
}

export function fmtDay(ms) {
  // 光判 isFinite 不够：试算框输入一个极小的日花费会算出 3e30 这种
  // "有限但超出 Date 范围"的值，new Date(3e30) 是 Invalid Date，
  // getMonth() 返回 NaN → 屏幕上出现「NaN/NaN NaN:NaN」。
  if (ms == null || !Number.isFinite(Number(ms)) || Math.abs(Number(ms)) > MAX_DATE_MS) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ────────────────────────────────────────────────────────────
// 滚动窗口的落点。用重置时刻倒推窗口何时开始：
//   elapsed = 窗口长度 − 距下次重置的时间
// 5h 窗口长度 5 小时，周窗口 7 天。样本不足就不给结论。
// ────────────────────────────────────────────────────────────
export function projectWindow(spec, periodMs, now) {
  if (!spec || !spec.started || !spec.resetAt || !(spec.cap > 0)) return null;
  // 重置时刻已经过去 → 这是一份过期读数。以前 leftMs 被夹到 0，
  // elapsedMs 于是等于整个窗口长度、projected 恒等于 used → 恒定报"安全"，
  // 把"早就该重置了"误读成"很安全"。
  if (spec.resetAt <= now) return null;
  const leftMs = Math.max(0, spec.resetAt - now);
  const elapsedMs = periodMs - Math.min(leftMs, periodMs);
  if (elapsedMs <= 0 || !(spec.used > 0)) return null;
  // 样本门槛要比月度那道严得多。
  // 月度用 5% 周期（1.5 天）就够，因为它的消耗是匀速的；
  // 但滚动窗口一开场往往是突发 —— 实测 5h 窗口跑了 16 分钟、用了 7.4%，
  // 按 5% 门槛（15 分钟）刚好放行，外推出来是 139%，纯噪声。
  // 原版 cc-usage 干脆不在状态栏显示 5h 的 pace，就是这个原因。
  // 取 20%：5h 窗口要跑满 1 小时、周窗口要过 1.4 天才给结论。
  const minSample = Math.max(30 * 60_000, periodMs * 0.2);
  if (elapsedMs < minSample) return null;
  const projected = (spec.used / elapsedMs) * periodMs;
  return {
    projectedPct: (projected / spec.cap) * 100,
    willExceed: projected > spec.cap,
    overBy: Math.max(0, projected - spec.cap),
    sampleMs: elapsedMs,
  };
}

// ────────────────────────────────────────────────────────────
// 格式化
// ────────────────────────────────────────────────────────────
const MAX_DATE_MS = 8.64e15; // ECMAScript Date 的合法上限（±1e8 天）

export function fmtMoney(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const a = Math.abs(v);
  // 均单价在 $0.003 量级，固定两位会把它压成 $0.00 —— 看着像坏了
  if (a === 0) return '$0.00';
  if (a < 0.01) return '$' + v.toFixed(4);
  if (a < 1) return '$' + v.toFixed(3);
  if (a >= 100) return '$' + v.toFixed(0);
  return '$' + v.toFixed(2);
}

export function fmtDays(d) {
  if (d === null || d === undefined || !Number.isFinite(Number(d))) return '—';
  const v = Number(d);
  if (v < 0) return '0d';
  if (v >= 10) return v.toFixed(0) + 'd';
  return v.toFixed(1) + 'd';
}

export function fmtPct(p) {
  if (!Number.isFinite(Number(p))) return '—';
  const v = Number(p);
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%';
}

// 照抄 cc-usage.mjs 的 resetText：>= 1 天显示日期，否则显示倒计时
export function resetText(w, now) {
  const at = w && Number(w.resetAt);
  if (!at || !Number.isFinite(at) || Math.abs(at) > MAX_DATE_MS) return null;
  const ms = w.resetsInMs != null ? w.resetsInMs : Math.max(0, w.resetAt - now);
  if (ms >= 86400000) {
    const d = new Date(w.resetAt);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 重置`;
  }
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  if (h > 0) return `${h}h${m > 0 ? m + 'm' : ''}后重置`;
  if (m > 0) return `${m}m后重置`;
  return `${t}s后重置`;
}

// ────────────────────────────────────────────────────────────
// 按宽度裁段：优先丢 prio 大的，prio 0 永不丢。
// ────────────────────────────────────────────────────────────
const SEG_GAP = 2;
// plain 按钮的实宽：热键 + ": " + 标签。
// 以前手写常量（"1 详情" = 6），漏了冒号和空格，宽度预算因此永远少 1 格。
// （Desktop 上画的是原生按钮，宽度由控件决定 —— 这里是保守估计。）
const plainButtonW = (label, hotkey) => dispWidth(String(hotkey)) + 2 + dispWidth(label);
const BUTTON_W = plainButtonW('详情', '1');

export function fitSegments(segs, cols, gap = SEG_GAP) {
  // 丢掉的是段对象本身，不是 id —— id 可能重复（两个分隔段的 id 都是 'sep'）。
  const dropped = new Set();
  const alive = () => segs.filter((s) => !dropped.has(s));
  // 每丢一段都要重算剩余宽度。原来 total() 一直按完整列表算，
  // 于是"还超宽"恒为真，一超宽就把所有 prio > 0 的段**一次全丢光**，
  // 留一堆本该被保留的段和一片空白。
  const total = () => {
    const now = alive();
    return now.reduce((a, s) => a + s.width, 0) + gap * Math.max(0, now.length - 1);
  };
  for (const seg of segs.filter((s) => s.prio > 0).sort((a, b) => b.prio - a.prio)) {
    if (total() <= cols) break;
    dropped.add(seg);
  }
  return alive();
}

// ────────────────────────────────────────────────────────────
// 布局：把一行拆成渲染无关的"段"。
//   { id, prio, width, kind:'text'|'meter'|'button', text?, parts?, label?, hotkey?,
//     color, bg, bold, dim }
// hooks 模块把段变成元素树，tools/mock.mjs 把段变成 HTML，
// 同一份布局两个出口 —— 所以我在浏览器里看到的排版就是屏幕上的排版。
//
// 显示顺序：月(主窗口) → 主条 → 还能撑多久 → 剩多少 → 5h 小条 → 周 小条 → 详情入口
// 主条是这个设计的招牌，放不下时它主动挤掉小窗口，而不是自己被丢掉。
// ────────────────────────────────────────────────────────────
export const WEEK_MS = 7 * 86400000;
export const FIVE_HOUR_MS = 5 * 3600000;

// 月窗口画成"落点条"需要的三个数。
//
// 这里以前是一个通用的 hero 抽象（在 月 / 周 / 5h 之间切主窗口），
// 但切换入口从没做出来（layoutPane 只以 'monthly' 调用它），于是
// HERO_ORDER / HERO_LABEL / heroSpecFor 和一个不可达分支长期挂着，
// register.mjs 还因此引用了一个**没 import 的 HERO_ORDER** ——
// 那行抛的 ReferenceError 被 catch 吞掉，把 marks 恢复整条逻辑废掉了
// （后果：引导 toast 每次启动都弹、档位 toast 每个进程重报一次）。
// 砍掉抽象，只留真正在用的那条路径。
export function monthlyHero(v, pace) {
  const m = v.monthly;
  const canProj = Boolean(pace && !pace.insufficient && m.total > 0);
  return {
    usedPct: m.percent,
    projPct: canProj ? (pace.projectedTotal / m.total) * 100 : null,
    color: quotaColor(m.percent, Boolean(canProj && pace.willExceed), pace && pace.runwayDays),
  };
}

// 布局：把一行拆成渲染无关的"段"。
//   { id, prio, width, kind:'text'|'meter'|'button', text?, parts?, label?, hotkey?, ... }
//
// 显示顺序：主窗口 → 落点条 → 落点结论 → 金额 → 其它两个窗口的小标 → 详情 / 切窗口
// 落点条是招牌，挤不下时它主动挤掉数字，而不是自己被丢掉。
// ────────────────────────────────────────────────────────────
// 三个窗口等权重地摆在一行里，各自一条落点条，中间用 │ 分隔。
//
// 两次教训：
//   1. 让"月"独占一根 30 格大条，把 周/5h 挤成没有分隔的小文字标 ——
//      用户看不到另外两个窗口，也分不清哪段是哪段。
//   2. 就算改成三条，只要宽度分配算错（没算段间距），窄屏下 5h/周 还是会被整段丢掉。
// 所以这里**三条给同样的宽度、一起伸缩**，谁也不会把谁挤没。
const BAR_MIN = 4;
const BAR_MAX = 14;

export function layoutRow(v, pace, tier, cols, now, stale) {
  const pacePr =
    pace && !pace.insufficient && v.monthly.total > 0
      ? {
          projectedPct: (pace.projectedTotal / v.monthly.total) * 100,
          willExceed: pace.willExceed,
          overBy: Math.max(0, pace.projectedTotal - v.monthly.total),
        }
      : null;

  const defs = [
    { key: 'five', label: '5h', spec: v.windows.fiveHour, pr: projectWindow(v.windows.fiveHour, FIVE_HOUR_MS, now) },
    { key: 'week', label: '周', spec: v.windows.weekly, pr: projectWindow(v.windows.weekly, WEEK_MS, now) },
    { key: 'mon', label: '月', spec: v.monthly, pr: pacePr },
  ];

  const T = (id, s, o = {}) => ({
    id,
    prio: o.prio ?? 0,
    kind: 'text',
    width: dispWidth(s),
    text: s,
    color: o.color ?? null,
    bg: null,
    bold: Boolean(o.bold),
    dim: Boolean(o.dim),
  });
  // 窗口数据缺失时显示「—」并转暗，不能显示 0.0% ——
  // 0.0% 与"这个窗口一点没用"完全同形，而面板对同一份数据是跳过整行，
  // 两处口径不一致会让人以为额度真的没用过。
  const labelOf = (d) => T(d.key + 'l', d.label, { bold: true, dim: stale || !d.spec });
  const pctOf = (d) =>
    d.spec
      ? T(d.key + 'p', fmtPct(d.spec.percent), { bold: true, dim: stale })
      : T(d.key + 'p', '—', { dim: true });
  const SEP = () => T('sep', ' │ ', { dim: true });
  // 详情入口可以丢（/quota 与快捷键仍在），三个窗口的百分比不能丢。
  const detail = { id: 'detail', kind: 'button', width: BUTTON_W, label: '详情', hotkey: '1', prio: 1 };

  // 谁超支就报谁的数，但**月优先** —— 月是主窗口。
  // 原来写的是 defs.find(...)，而 defs 的顺序是 [5h, 周, 月]，
  // 于是只要 5h 超支就报 5h 的数，却紧挨着「月 52%」显示：
  // 实测月超 $14、5h 超 $1 时，读起来是"月只超 $1"。
  // 文案也带上窗口名，否则并列的三个窗口会让人认错这个数属于谁。
  const over =
    defs.find((d) => d.key === 'mon' && d.pr && d.pr.willExceed) ||
    defs.filter((d) => d.pr && d.pr.willExceed).sort((a, b) => b.pr.overBy - a.pr.overBy)[0] ||
    null;
  const foot = over
    ? T('foot', over.label + '超 ' + fmtMoney(over.pr.overBy), { color: 'error', bold: true })
    : pacePr
      ? T('foot', '安全', { color: 'success' })
      : null;
  // 没有落点结论时（样本不足 / 未启动）至少把档位词放出来 ——
  // tier 一直是 layoutRow 的形参却从没被读过，于是"采样中"这个状态
  // 在输入框上方那行里根本不存在，用户看到的是三个没有任何结论的裸数字。
  const tierSeg = tier && tier.word && !foot
    ? T('tier', tier.word, { color: stale ? null : tier.color, bold: Boolean(tier.bold) && !stale, dim: stale })
    : null;

  const skeleton = (withFoot, withTier) => {
    const a = [];
    if (tierSeg && withTier) a.push(tierSeg);
    defs.forEach((d, i) => {
      if (i > 0) a.push(SEP());
      a.push(labelOf(d), pctOf(d));
    });
    if (withFoot && foot) a.push(foot);
    a.push(detail);
    return a;
  };
  // 三条各占 n + SEG_GAP
  const fitBars = (a) => Math.min(BAR_MAX, Math.floor((cols - widthOfSegs(a) - 3 * SEG_GAP) / 3));

  // 降级顺序：档位词 → 落点结论 → 干脆不画条。
  // 三个窗口的标签与百分比**永不丢** —— 这是踩过两次坑换来的硬约束
  // （用户原话："只能看到5小时的限额看不到周限额"）。
  let withTier = Boolean(tierSeg);
  let withFoot = true;
  let n = fitBars(skeleton(withFoot));
  if (n < BAR_MIN && withTier) {
    withTier = false;
    n = fitBars(skeleton(withFoot));
  }
  if (n < BAR_MIN && foot) {
    withFoot = false;
    n = fitBars(skeleton(withFoot));
  }
  if (n < BAR_MIN) n = 0;

  const out = [];
  if (tierSeg && withTier) out.push(tierSeg);
  defs.forEach((d, i) => {
    if (i > 0) out.push(SEP());
    out.push(labelOf(d));
    if (n > 0 && d.spec) {
      const pct = d.spec.percent;
      const color = stale
        ? null
        : d.key === 'mon'
          ? quotaColor(pct, Boolean(pacePr && pacePr.willExceed), pace && pace.runwayDays)
          : levelColor(pct);
      out.push({
        id: d.key + 'bar',
        // 条是最先该牺牲的：百分比已经说明了同一件事，而窗口的百分比永不丢。
        // 以前这里也是 prio 0（永不可丢），于是 fitSegments 其实是个空操作。
        prio: 2,
        kind: 'meter',
        width: n,
        parts: landingParts(pct, d.pr ? d.pr.projectedPct : null, n, color).parts,
      });
    }
    out.push(pctOf(d));
  });
  if (withFoot && foot) out.push(foot);
  out.push(detail);

  const fitted = fitSegments(out, cols);
  if (widthOfSegs(fitted) <= cols) return fitted;
  // 连最精简的骨架都放不下时，**绝不退化成"什么都不画"**。
  //
  // 这一条是踩出来的：band 在 Desktop Code tab 上的可用列数比终端窄得多
  // （终端里 80 格够用，那个界面上不够），而三个窗口加「详情」的最小骨架
  // 要 45 格。放不下就整行不画，结果是**一整行空白 —— 和「mod 没装」
  // 长得一模一样**，只能靠猜该去查配置还是该去查宽度。
  // 空白说不出任何事，所以退化成主窗口的一个百分比：约 6 格，任何宽度都放得下，
  // 而且它仍然是那个唯一的问题（额度还够不够）。
  return compactRow(v, pace, cols);
}

// 放不下时的最小可用形态：主窗口百分比 + 档位颜色。
function compactRow(v, pace, cols) {
  const tier = tierOf(v, pace);
  for (const text of ['月 ' + fmtPct(v.monthly.percent), fmtPct(v.monthly.percent)]) {
    const width = dispWidth(text);
    if (width > cols) continue;
    return [{
      id: 'monp',
      prio: 0,
      kind: 'text',
      width,
      text,
      color: tier.color,
      bg: null,
      bold: true,
      dim: false,
    }];
  }
  return [];
}

function widthOfSegs(a) {
  return a.reduce((x, s) => x + s.width, 0) + SEG_GAP * (a.length - 1);
}

// ────────────────────────────────────────────────────────────
// 详情面板的布局，和 layoutRow 同一套"段"模型。
// 返回 { rows: [ {kind:'row', segs:[...]} | {kind:'gap'} ] }，
// 由调用方把段变成元素（hooks）或 HTML（tools/mock.mjs）。
// ────────────────────────────────────────────────────────────
export function layoutPane(v, pace, tier, cols, now, stale, whatIf) {
  const m = v.monthly;
  const fh = v.windows.fiveHour;
  const wk = v.windows.weekly;
  const short = Boolean(pace && !pace.insufficient && pace.willExceed);
  // 面板的固定部分（名称 5 + 百分比 6 + 金额 16 + 重置文案 26）本身就有 53 格，
  // 而这里原来固定给 10~22 格、从不参考列数 —— 于是 58 列的面板里「周」行宽 71 格，
  // 最右边的重置时刻被挤到下一行。现在条只吃剩下的空间。
  const PANE_FIXED = 54;
  const cells = Math.max(0, Math.min(22, cols - PANE_FIXED));

  const T = (id, s, opts = {}) => ({
    id,
    prio: opts.prio ?? 0,
    kind: 'text',
    width: dispWidth(s),
    text: s,
    color: opts.color ?? null,
    bg: null,
    bold: Boolean(opts.bold),
    dim: Boolean(opts.dim),
  });
  const M = (id, pct, n, fill) => ({
    id,
    prio: 1,
    kind: 'meter',
    width: n,
    parts: meterParts(pct, n, fill || levelColor(pct)),
  });
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - dispWidth(s)));

  const rows = [];
  // 面板每一行也按可用列数裁一遍：renderPane 把段直接相邻排列（没有分隔符），
  // 所以 gap 用 0。以前面板完全不做裁剪，58 列的面板里排到 71 格宽。
  const row = (...segs) => rows.push({ kind: 'row', segs: fitSegments(segs, cols, 0) });
  const gap = () => rows.push({ kind: 'gap' });

  row(
    // 不带图标：token-weather 用 ☀☁☂ 是因为天气人人秒懂，
    // ◑ 这类 Geometric Shapes 在有些字体里会渲染成一个大圆圈，既不好看也没人认得。
    // 档位靠**颜色 + 词**表达就够了。
    T('t1', tier.word, {
      color: stale ? null : tier.color,
      bold: !stale,
      dim: stale,
    }),
    T('t2', '    已用 ' + fmtPct(m.percent), { bold: true }),
    T(
      't3',
      '   ·   ' +
        (v.plan.name || '—') +
        (v.plan.daysLeft != null ? ' · 周期还剩 ' + v.plan.daysLeft + ' 天' : ''),
      { dim: true, prio: 2 },
    ),
  );
  gap();

  const winRow = (key, name, spec, fill) => {
    const pct = spec ? spec.percent : 0;
    const segs = [
      T(key + 'n', pad(name, 5), { dim: true, bold: true }),
      T(key + 'p', pad(fmtPct(pct), 6), { bold: true }),
    ];
    if (cells > 0) segs.push(M(key + 'm', pct, cells, fill));
    segs.push(
      // 月窗口的上限字段叫 total，滚动窗口叫 cap
      T(
        key + 'v',
        '  ' +
          fmtMoney(spec ? spec.used : 0) +
          ' / ' +
          fmtMoney(spec && spec.total != null ? spec.total : spec && spec.cap),
        { prio: 2 },
      ),
    );
    const r = spec ? resetText(spec, now) : null;
    if (r) segs.push(T(key + 'r', '     ' + r, { dim: true, prio: 3 }));
    row(...segs);
  };

  // 月条画成落点条：实心=已花，斜纹=还将花掉
  {
    const h = monthlyHero(v, pace);
    const segs = [
      T('mn', pad('月', 5), { dim: true, bold: true }),
      T('mp', pad(fmtPct(m.percent), 6), { bold: true }),
    ];
    if (cells > 0) {
      segs.push({
        id: 'mm',
        prio: 1,
        kind: 'meter',
        width: cells,
        parts: landingParts(h.usedPct, h.projPct, cells, stale ? null : h.color).parts,
      });
    }
    segs.push(T('mv', '  ' + fmtMoney(m.used) + ' / ' + fmtMoney(m.total), { prio: 2 }));
    row(...segs);
  }
  if (pace && !pace.insufficient) {
    // 「还能撑多久」与「断粮时刻」合成一行并前置。
    // 长度可以拖，时刻不能 —— 人会自动把时刻跟日历上别的事对照，所以它比天数扎心得多。
    // 以前这句在第 3 行、绝对时刻在第 14 行，同一件事说了两遍，还都排在后面。
    const at = pace.perDay > 0 ? exhaustAtMs(m.remaining, pace.perDay, now) : null;
    row(
      T('p1', '断粮        ', { dim: true }),
      T('p2', at != null ? fmtDay(at) : '—', short ? { color: 'error', bold: true } : {}),
      T(
        'p3',
        short
          ? '   比周期末早 ' + fmtDays(pace.gapDays) + '（还能撑 ' + fmtDays(pace.runwayDays) + '）'
          : '   撑得到周期末（还能撑 ' + fmtDays(pace.runwayDays) + '）',
        { dim: true, prio: 2 },
      ),
    );
  }
  gap();

  if (fh && fh.started) {
    winRow('h', '5h', fh);
  } else if (fh) {
    row(
      T('hn', pad('5h', 5), { dim: true, bold: true }),
      T('hp', '未启动', { dim: true }),
      T('hv', '          上限 ' + fmtMoney(fh.cap), { dim: true, prio: 2 }),
    );
  }
  if (wk) winRow('w', '周', wk);
  gap();

  row(
    T('d1a', '本周期均速  ', { dim: true }),
    T(
      'd1b',
      pace && !pace.insufficient
        ? fmtMoney(pace.perDay) + '/天（样本 ' + fmtDays(pace.sampleDays) + '）'
        : '样本不足，暂不外推',
      { dim: true, prio: 1 },
    ),
  );
  if (pace && !pace.insufficient) {
    row(
      T('d2a', '周期末预计  ', { dim: true }),
      T(
        'd2b',
        fmtMoney(pace.projectedTotal) +
          ' / ' +
          fmtMoney(m.total) +
          (short ? '   会超 ' + fmtMoney(pace.projectedTotal - m.total) : ''),
        short ? { color: 'warning', bold: true, prio: 1 } : { dim: true, prio: 1 },
      ),
    );
  }
  row(
    T('d3a', '均单价      ', { dim: true }),
    T(
      'd3b',
      (v.avgCostPerRequest ? fmtMoney(v.avgCostPerRequest) + '/次' : '—') +
        (v.requestCount ? '   ·   本期 ' + v.requestCount + ' 次请求' : ''),
      { dim: true, prio: 3 },
    ),
  );
  gap();

  row(
    T('f1', stale ? '读数可能已过期 · ' : '快照 ', { dim: true }),
    T(
      'f2',
      Math.max(0, Math.round((now - snapAtSafe(v, now)) / 1000)) + ' 秒前' + (stale ? '（刷新失败，显示的是旧读数）' : ''),
      { dim: true, prio: 1 },
    ),
  );
  gap();

  // 断粮时刻已经并入上面的「断粮」行（前置了），这里不再重复一遍
  gap();

  // 试算：换一个花法会怎样。纯本地计算，不打接口。
  row(
    T('w1', '试算        ', { dim: true }),
    {
      id: 'whatif',
      kind: 'input',
      width: 22,
      label: '每天 $ ',
      placeholder: pace && !pace.insufficient ? pace.perDay.toFixed(2) : '2.00',
      submitLabel: '算',
    },
  );
  if (whatIf != null) {
    const rate = Number(whatIf);
    if (!Number.isFinite(rate) || rate <= 0) {
      row(T('w2', '            ', {}), T('w3', '填一个大于 0 的数', { dim: true }));
    } else {
      const ends = v.plan.periodEndMs;
      // 余量为 0 时 exhaustAtMs 返回 null。以前这里不判 null，
      // 而 `ends - null` 得到的是"从 1970 年到现在"的毫秒数，
      // 于是屏幕上出现「这样会烧到 —，比周期末早 20543d 断」。
      const at = exhaustAtMs(m.remaining, rate, now);
      const safe = at != null && ends != null && at >= ends;
      row(
        T('w2', '            ', {}),
        T(
          'w3',
          at == null
            ? '已经没有余量了，怎么花都会超'
            : rate === (pace && pace.perDay)
              ? '就是当前速度'
              : '这样会烧到 ' +
                fmtDay(at) +
                (safe
                  ? ' —— 撑得到周期末'
                  : ends != null
                    ? '，比周期末早 ' + fmtDays((ends - at) / 86400000) + ' 断'
                    : ''),
          safe ? { color: 'success' } : { color: 'error', bold: true },
        ),
      );
      if (safe) {
        const budget = m.remaining / Math.max(1, (ends - now) / 86400000);
        row(T('w4', '            ', {}), T('w5', '也就是每天不超过 ' + fmtMoney(budget) + ' 就不会超', { dim: true, prio: 2 }));
      }
    }
  }
  gap();

  row(
    { id: 'refresh', kind: 'button', width: plainButtonW('刷新', '1'), label: '刷新', hotkey: '1' },
    T('bs', '   '),
    { id: 'copy', kind: 'button', width: plainButtonW('复制快照', '2'), label: '复制快照', hotkey: '2' },
  );

  return rows;
}

// 面板里显示"快照多久之前"，但要和 hooks 侧真正记的抓取时刻一致。
// 纯函数拿不到那个模块变量，所以由调用方通过 v.fetchedAt 带进来。
function snapAtSafe(v, now) {
  const t = Number(v && v.fetchedAt);
  return Number.isFinite(t) && t > 0 ? t : now;
}

// ────────────────────────────────────────────────────────────
// 可复制的纯文本快照：一屏自解释，带上口径与时间戳，
// 能直接贴给同事或存进 issue。
// ────────────────────────────────────────────────────────────
export function snapshotText(v, now) {
  const pace = computePace(v, now);
  const tier = tierOf(v, pace);
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const lines = [
    `runway · ${v.plan.name || '—'} · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
    `月额度   ${fmtPct(v.monthly.percent)} 已用 · 剩 ${fmtMoney(v.monthly.remaining)} / ${fmtMoney(v.monthly.total)}`,
    `周期     剩 ${v.plan.daysLeft != null ? v.plan.daysLeft + ' 天' : '—'}`,
  ];
  const fh = v.windows.fiveHour;
  const wk = v.windows.weekly;
  if (fh) {
    lines.push(
      `5h 窗口  ${fh.started ? `${fmtPct(fh.percent)} 已用 · ${fmtMoney(fh.used)} / ${fmtMoney(fh.cap)}${fh.resetsInMs != null ? ' · ' + resetText(fh, now) : ''}` : `未启动（上限 ${fmtMoney(fh.cap)}）`}`,
    );
  }
  if (wk) {
    lines.push(
      `周窗口   ${fmtPct(wk.percent)} 已用 · ${fmtMoney(wk.used)} / ${fmtMoney(wk.cap)}`,
    );
  }
  if (pace && !pace.insufficient) {
    lines.push(
      `节奏     ${tier.word} · 均速 ${fmtMoney(pace.perDay)}/天（样本 ${fmtDays(pace.sampleDays)}）`,
    );
    lines.push(
      `预测     ${pace.willExceed ? `提前 ${fmtDays(pace.gapDays)} 耗尽` : '不会超支'} · 周期末预计 ${fmtMoney(pace.projectedTotal)} / ${fmtMoney(v.monthly.total)}`,
    );
    if (v.avgCostPerRequest) {
      lines.push(`均单价   ${fmtMoney(v.avgCostPerRequest)}/次`);
    }
  } else {
    lines.push('节奏     样本不足，暂不外推');
  }
  return lines.join('\n');
}
