// runway · hooks 模块
//
// 把 Command Code 套餐的"还剩多少 / 还能撑多久"画在输入框上方。
//
// 三条硬规矩（写错就白干）：
//   1. `$` 只能原样写 `$.noun.method(...)`，不能赋给变量、不能解构、
//      不能传给对象成员方法。只允许传给**本文件顶层声明的函数**。
//   2. `ui.render` 里**绝不发网络请求** —— 它按输入值缓存，但一
//      invalidate 就会重跑，而 await 网络会把这一帧拖住。渲染只读模块变量。
//   3. 必须 `await next(e)` 并把它嵌进自己的 Box，否则会抹掉
//      token-weather（它在有读数时直接 return，短路口后的所有 band mod）。

import {
  computePace,
  fmtDays,
  fmtMoney,
  fnv1a,
  layoutPane,
  layoutRow,
  normalize,
  scanForProviderKey,
  snapshotText,
  tierOf,
} from '../lib/quota.mjs';

const PANE_ID = 'runway';
const CACHE_KEY = 'runway.cache';
const MARKS_KEY = 'runway.marks';

const API_BASE = 'https://api.commandcode.ai';
const TTL_MS = 180_000; // 与 cc-usage.mjs 的 cacheTtl 同值
const TURN_DEBOUNCE_MS = 15_000;
// 取数的看门狗。$.http.fetch **没有 timeoutMs**（类型定义里 HttpInit 只有
// method/headers/body/auth/socketPath），DNS 卡死或代理黑洞会让它永不 settle，
// 而 inflight 只在 finally 里清空 —— 那样 refresh() 会永远返回同一个 pending
// promise，此后一个请求都不再发，面板永久停在旧读数且只标"陈旧"。
// 所以自己看时间：挂太久就当作失败，允许下一次重试。
const FETCH_HUNG_MS = 45_000;

// 凭据候选文件（相对 home）。本机命中的是第一条。
const CONFIG_PATHS = [
  '.zcode/v2/provider_config.json',
  '.config/opencode/opencode.json',
  '.pi/agent/settings.json',
  '.claude/settings.json',
];

// ── 模块状态（热重载会清空，session.start 会重新灌回来）──
let snap = null; // 当前读数；渲染只读它
let snapAt = 0;
let inflight = null;
let inflightAt = 0;
let lastTurnRefresh = 0;
let lastErrorAt = 0; // 最近一次取数失败的时刻，手动刷新用它给回执
let credFound = false; // 有没有找到凭据 —— 决定没读数时状态行写哪个原因
let marks = { announcedCycle: null, announcedTier: null, sawDetail: false };
let whatIf = null; // 试算输入的内容（纯本地计算，不发请求）
const timers = [];

// ════════════════════════════════════════════════════════════
// 注册
// ════════════════════════════════════════════════════════════
export function register(on) {
  on('session.start', async ($, e, next) => {
    // 先把 next(e) 走完，别的 mod 的启动逻辑不受我们影响
    const result = await next(e);

    await hydrate($); // 只读本地 store，快
    refresh($); // 不 await：网络请求可能永久挂起（见文件末的说明）

    const stop = $.clock.every(TTL_MS, () => {
      refresh($);
    });
    timers.push(stop);

    if (!marks.sawDetail) {
      $.ui.toast('额度条在输入框上方 · 按 1 或 /quota 看明细');
    }

    // 命令最后注册；名字冲突时抛错，不能连累上面几件事
    try {
      await $.command.register({
        name: 'quota',
        description: '显示 Command Code 套餐额度与节奏',
      });
    } catch {
      /* /quota 被别的插件占了，band 照常工作 */
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    // 子 agent 的 turn 不算，避免一节里刷很多次
    if (!e.agentId && Date.now() - lastTurnRefresh > TURN_DEBOUNCE_MS) {
      lastTurnRefresh = Date.now();
      refresh($);
    }
    return result;
  });

  on('command.run', { command: 'quota' }, async ($) => {
    if (!snap) await hydrate($);
    // 必须 await：refresh 是 async，不 await 的话下面那句判的还是 null，
    // /quota 在冷启动时 100% 返回"取不到"，而网络其实几十毫秒后就好了。
    if (!snap) await refresh($);
    if (!snap) {
      return { text: '额度暂时取不到：没找到 Command Code 凭据，或接口不可达。' };
    }
    return { text: snapshotText(snap, Date.now()) };
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e); // 别人的 band（token-weather 就在里面）
    // 宽度和问卷标记都在 **e.props** 里，不在 e 上。
    // 以前读 e.bodyColumns / e.hasSurvey，两者恒为 undefined ——
    // 后果是 band 永远按兜底的 80 列排版（宽屏浪费、窄屏溢出），
    // 而且问卷出现时不让位，两块内容叠在一起。
    // 这句在 try 之外，所以对 props 缺失也要免疫（缺了就当没有问卷）。
    if (e.props && e.props.hasSurvey) return rest; // 有问卷时让位
    // 2.1.288 上，ui.render 抛错或交回坏树会让**整个会话**以
    // "unrecoverable interface error" 结束（2.1.289 才改成引擎自己兜底）。
    // 所以在自己这层就吞掉，画不出来就让位。
    try {
      // 没读数时不再直接让位：那样"没装"和"装了但取不到数"长得一模一样，
      // 只能靠猜该去查配置还是该去查网络。改画一行状态，把原因写在屏幕上。
      const row = snap ? renderRow($, e) : renderStatus($, e);
      if (!row) return rest;
      if (!rest) return row;
      const { Box } = $.ui.resolve(e);
      return Box({ flexDirection: 'column', children: [rest, row] });
    } catch {
      return rest;
    }
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || !snap) return next(e);
    const rest = await next(e);
    try {
      return renderPane($, e);
    } catch {
      return rest;
    }
  });

  on('session.end', async ($, e, next) => {
    for (const timer of timers.splice(0)) {
      try {
        // $.clock.every 返回的是 { cancel() } 对象，不是函数。
        // 以前这里写 `typeof stop === 'function'` → 恒为 false →
        // 定时器在 session.end 从来没被取消过一次。
        if (timer && typeof timer.cancel === 'function') timer.cancel();
      } catch {
        /* 定时器可能已经不在 */
      }
    }
    return next(e);
  });
}

// ════════════════════════════════════════════════════════════
// 取数（全部接受 $ 作为参数的函数都在本文件顶层）
// ════════════════════════════════════════════════════════════

function readDoc(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

async function hydrate($) {
  try {
    const doc = readDoc(await $.store.get(CACHE_KEY));
    if (doc && doc.view) {
      snap = doc.view;
      snapAt = doc.savedAt || 0;
    }
  } catch {
    /* store 读不到就等着网络 */
  }
  try {
    const m = readDoc(await $.store.get(MARKS_KEY));
    if (m && typeof m === 'object') {
      marks = {
        announcedCycle: m.announcedCycle ?? null,
        announcedTier: m.announcedTier ?? null,
        sawDetail: Boolean(m.sawDetail),
      };
    }
  } catch {
    /* 同上 */
  }
}

function saveMarks($) {
  $.store.set(MARKS_KEY, marks).catch(() => {});
}

// 凭据：先三个字面量环境变量，再 settings 的 env 段，最后读配置文件。
// （`$.env.get` 只吃字符串字面量，所以"遍历环境变量找含 commandcode 的键"这条路走不通。）
async function findCredential($) {
  const KEY_SHAPE = /^(user_|cc_)[A-Za-z0-9_-]{8,}$/;

  const a = await $.env.get('COMMAND_CODE_API_KEY');
  if (a && KEY_SHAPE.test(a.trim())) return { apiKey: a.trim(), apiBase: null };

  const b = await $.env.get('COMMANDCODE_API_KEY');
  if (b && KEY_SHAPE.test(b.trim())) return { apiKey: b.trim(), apiBase: null };

  const c = await $.env.get('CMD_API_KEY');
  if (c && KEY_SHAPE.test(c.trim())) return { apiKey: c.trim(), apiBase: null };

  try {
    const s = await $.settings.read();
    const env = s && typeof s.env === 'object' && s.env ? s.env : null;
    if (env) {
      for (const name of Object.keys(env)) {
        if (!/commandcode/i.test(name)) continue;
        const val = env[name];
        if (typeof val === 'string' && KEY_SHAPE.test(val.trim())) {
          return { apiKey: val.trim(), apiBase: null };
        }
      }
    }
  } catch {
    /* settings 读不到就继续 */
  }

  let home = '';
  try {
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '';
  } catch {
    home = '';
  }
  if (!home) return null;
  const sep = home.includes('\\') ? '\\' : '/';

  for (const rel of CONFIG_PATHS) {
    const path = home + sep + rel.split('/').join(sep);
    let text;
    try {
      text = await $.fs.read(path);
    } catch {
      continue; // 不存在，或超过单文件 4 MiB
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    const hit = scanForProviderKey(doc);
    if (hit) {
      return {
        // https://api.commandcode.ai/provider/v1 → https://api.commandcode.ai
        apiBase: hit.baseUrl.replace(/\/provider\/v\d+\/?$/, '').replace(/\/+$/, ''),
        apiKey: hit.apiKey,
      };
    }
  }
  return null;
}

async function getJson($, url, headers) {
  const res = await $.http.fetch(url, { method: 'GET', headers });
  // $.http.fetch 对非 2xx 不抛错，必须自己判，否则会解析到错误正文
  if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'no-response'));
  const body = JSON.parse(res.text);
  if (!body || typeof body !== 'object') throw new Error('non-JSON body');
  return body;
}

// 重新取数。不 await 网络的那条路是刻意为之：$.http.fetch 没有 timeoutMs，
// 而 $ 调用的耗时又不计入 hook 预算 —— 挂起会一直挂着，所以绝不让它挡住 hook。
// 代价是必须自己看时间（见 FETCH_HUNG_MS），否则一次挂起就永久静默。
function refresh($) {
  if (inflight && Date.now() - inflightAt < FETCH_HUNG_MS) return inflight;
  inflightAt = Date.now();
  inflight = (async () => {
    try {
      const cred = await findCredential($);
      if (!cred) {
        credFound = false;
        lastErrorAt = Date.now();
        return;
      }
      credFound = true;
      const digest = fnv1a(cred.apiKey);

      const cached = readDoc(await $.store.get(CACHE_KEY));
      const sameAccount = cached && cached.digest === digest;
      if (sameAccount && cached.view && Date.now() - (cached.savedAt || 0) < TTL_MS) {
        adopt(cached.view, cached.savedAt, $);
        return;
      }

      const base = (cred.apiBase || API_BASE).replace(/\/+$/, '');
      const headers = {
        Authorization: 'Bearer ' + cred.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'runway-mod/0.1.0',
      };

      // whoami 整个省掉：实测 org 恒为 null，credits 不需要 orgId。
      // credits 与 subscriptions 无依赖，并行；summary 依赖 subscriptions 的周期起点，串行。
      const [credits, subs] = await Promise.all([
        getJson($, base + '/alpha/billing/credits', headers),
        getJson($, base + '/alpha/billing/subscriptions', headers),
      ]);
      const since = subs && subs.data && subs.data.currentPeriodStart;
      const summary = await getJson(
        $,
        base + '/alpha/usage/summary' + (since ? '?since=' + encodeURIComponent(since) : ''),
        headers,
      );

      const now = Date.now();
      // 不把 apiBase / 凭据来源写进 view：它们对界面没用，
      // 而 ~/.claude 是同步、备份、共享配置的常见目标，没有必要
      // 在磁盘上留一份"私有网关地址 + 个人消费"的长期记录。
      const view = normalize({ credits, subscription: subs, summary }, { now });
      await $.store.set(CACHE_KEY, { savedAt: now, digest, view });
      adopt(view, now, $);
    } catch {
      // 取失败：保留旧读数（下次仍会重试），界面自己会标"陈旧"。
      // 记下时刻好让手动刷新能给一句诚实的回执；再 invalidate 一次 ——
      // ui.render 是按输入值缓存的，不 invalidate 的话"快照 N 秒前"永远不动。
      lastErrorAt = Date.now();
      try {
        $.ui.invalidate('ui.render');
      } catch {
        /* 还没有界面可刷新 */
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function adopt(view, at, $) {
  snap = view;
  snapAt = at || Date.now();
  $.ui.invalidate('ui.render');
  announce($, view);
}

// ── 事件驱动预警：只有跨档才说话，且每档每周期只报一次 ──
function announce($, v) {
  const pace = computePace(v, Date.now());
  const tier = tierOf(v, pace);
  const cycleKey = v.plan.periodStartMs ? String(v.plan.periodStartMs) : 'unknown';
  if (marks.announcedCycle !== cycleKey) {
    marks.announcedCycle = cycleKey;
    marks.announcedTier = null;
  }
  if (marks.announcedTier === tier.word) return;
  marks.announcedTier = tier.word;
  saveMarks($);

  // 宽裕与采样中不值得打断
  if (tier.word === '宽裕' || tier.word === '采样中') return;
  if (tier.word === '断粮') {
    $.ui.toast('额度已用尽 · 剩 ' + fmtMoney(v.monthly.remaining));
    return;
  }
  if (!pace || pace.insufficient) return;
  $.ui.toast(
    '额度' +
      tier.word +
      ' · 按本周期均速还能撑 ' +
      fmtDays(pace.runwayDays) +
      '，比周期结束早 ' +
      fmtDays(pace.gapDays),
  );
}

// ════════════════════════════════════════════════════════════
// 渲染：输入框上方那一行
// ════════════════════════════════════════════════════════════

// 段 → 元素。颜色只有三个来源：
//   · 原始 ANSI 色名（green/yellow/red）画**背景**实心条 —— 最鲜明
//   · 主题令牌（success/warning/error/rate_limit_empty）做前景与轨道 —— 明暗自适应
//   · dimColor —— 次要信息
// **不写 hex**：color/backgroundColor 是 string 没有枚举，非法值不报错，
// 表现为整行消失，极难排查。
function textOf(Text, key, s) {
  const props = { key, children: s.text };
  if (s.color) props.color = s.color;
  if (s.bg) props.backgroundColor = s.bg;
  if (s.bold) props.bold = true;
  if (s.dim) props.dimColor = true;
  return Text(props);
}

function meterNode(Box, Text, key, parts) {
  return Box({
    key,
    flexDirection: 'row',
    children: parts.map((p, j) => textOf(Text, key + '-' + j, p)),
  });
}

// 没有读数时画这一行，把原因写在屏幕上。
// 「没装」和「装了但取不到数」在静默让位时长得一模一样 —— 用户只能靠猜。
function renderStatus($, e) {
  const { Box, Text } = $.ui.resolve(e);
  const why = credFound ? '取数失败 · 接口或网络不可达' : '没找到 Command Code 凭据';
  return Box({
    flexDirection: 'row',
    paddingX: 1,
    children: [Text({ dimColor: true, children: `额度条 · ${why}` })],
  });
}

function renderRow($, e) {
  const { Box, Text, Button } = $.ui.resolve(e);
  // 可用宽度在 **e.props** 里。以前读 e.bodyColumns，恒为 undefined，
  // 于是这一行永远按兜底的 80 列排版：宽屏浪费、窄屏溢出被截。
  // 再减去 Box 自己的 paddingX: 1（左右各一格）—— 这两格以前完全没进预算，
  // 80 列的终端上这一行实际占 82 格，会折行。
  const cols = Math.max(20, (e.props?.bodyColumns ?? 80) - 2);
  const now = Date.now();
  const v = snap;
  const pace = computePace(v, now);
  const tier = tierOf(v, pace);
  const stale = now - snapAt > TTL_MS * 2;
  const segs = layoutRow(v, pace, tier, cols, now, stale);
  if (!segs.length) return null;

  const children = [];
  segs.forEach((s, i) => {
    if (i > 0) children.push(Text({ key: 'rw-sp' + i, children: '  ' }));
    if (s.kind === 'button') {
      children.push(
        Button({
          key: 'rw-' + s.id,
          label: s.label,
          hotkey: s.hotkey,
          plain: true,
          onPress: () => {
            openDetail($);
          },
        }),
      );
    } else if (s.kind === 'meter') {
      children.push(meterNode(Box, Text, 'rw-' + s.id, s.parts));
    } else {
      children.push(textOf(Text, 'rw-' + s.id, s));
    }
  });
  return Box({ flexDirection: 'row', paddingX: 1, children });
}

// ════════════════════════════════════════════════════════════
// 交互
// ════════════════════════════════════════════════════════════

// 试算：纯本地算术，不打接口、不改任何东西
function setWhatIf($, text) {
  whatIf = String(text == null ? '' : text).trim() || null;
  $.ui.invalidate('ui.render');
}

async function openDetail($) {
  marks.sawDetail = true;
  saveMarks($);
  const placed = await $.ui.open({
    id: PANE_ID,
    title: '额度',
    focus: true,
    closeOnEscape: true,
    // 面板内容 17 行起（用了试算 19 行），原来声明 18 就装不下，
    // 底部的「刷新 / 复制快照」按钮落在窗框之外点不到。
    // 宽度同理：固定部分就有 53 格，58 列会让「周」行折行。
    rows: 22,
    columns: 74,
  });
  // < 144 列（从没开过）/ < 110 列时面板会静默不放置。不提示的话，
  // 用户按了 1 什么也没发生，而且没有任何报错。
  if (placed && placed.isPlaced === false) {
    $.ui.toast('终端太窄，放不下面板 · 拉宽后再按 1');
  }
}

function copySnapshot($, surface) {
  $.ui.copy({ text: snapshotText(snap, Date.now()), surface });
  $.ui.toast('额度快照已复制');
}

function manualRefresh($) {
  const startedAt = Date.now();
  $.ui.toast('正在刷新…');
  refresh($).then(() => {
    $.ui.invalidate('ui.render');
    // refresh 内部把错误全吞了（网络路径不该抛给 hook），所以只能靠
    // "这次尝试期间有没有记下失败"来给回执。否则刷新成功与失败长得一模一样，
    // 用户只能自己盯着"快照 N 秒前"推断。
    $.ui.toast(lastErrorAt >= startedAt ? '刷新失败 · 显示的是旧读数' : '已更新');
  });
}

function renderPane($, e) {
  const { Box, Text, Button, Input } = $.ui.resolve(e);
  const now = Date.now();
  const pace = computePace(snap, now);
  const tier = tierOf(snap, pace);
  const stale = now - snapAt > TTL_MS * 2;
  const cols = Math.max(30, e.props?.bodyColumns ?? 56);

  // 布局是纯函数，这里只负责把段变成元素、把按钮接到处理函数
  const handlers = {
    refresh: () => {
      manualRefresh($);
    },
    copy: (press) => {
      copySnapshot($, press.surface);
    },
  };

  const children = [];
  layoutPane(snap, pace, tier, cols, now, stale, whatIf).forEach((r, i) => {
    if (r.kind === 'gap') {
      children.push(Text({ key: 'rw-pg' + i, children: ' ' }));
      return;
    }
    const kids = r.segs.map((s) => {
      if (s.kind === 'meter') return meterNode(Box, Text, 'rw-' + s.id, s.parts);
      if (s.kind === 'input') {
        // mobile 的元素表里**没有 Input**（类型定义原文："No `Input` or `Select`"），
        // 而 Pane 在 mobile 上也会触发。直接调用 Input(...) 会抛错、
        // 被上面的 catch 吞掉，于是整个面板在手机上是一片空白。
        // 画不了输入框就跳过这一行 —— 试算是附加功能，不该拖垮整个面板。
        if (!Input) return null;
        return Input({
          key: 'rw-' + s.id,
          label: s.label,
          placeholder: s.placeholder,
          submitLabel: s.submitLabel,
          onSubmit: (text) => {
            setWhatIf($, text);
          },
        });
      }
      if (s.kind === 'button') {
        const props = {
          key: 'rw-' + s.id,
          label: s.label,
          hotkey: s.hotkey,
          plain: true,
          onPress: (press) => {
            handlers[s.id](press);
          },
        };
        // autoFocus 只接受 true。落在后果最小的控件上：焦点在"复制"，
        // 回车是复制而不是刷新（照抄 blast-radius 把 autoFocus 给 Cancel）。
        if (s.id === 'copy') props.autoFocus = true;
        return Button(props);
      }
      return textOf(Text, 'rw-' + s.id, s);
    });
    children.push(Box({ key: 'rw-pr' + i, flexDirection: 'row', children: kids.filter(Boolean) }));
  });
  return Box({ flexDirection: 'column', children });
}
