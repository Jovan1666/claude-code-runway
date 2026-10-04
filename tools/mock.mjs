#!/usr/bin/env node
// runway · 视觉稿生成器
//
// 把**真实布局函数**的输出画成 HTML，用浏览器截图后肉眼比对。
//
// 为什么必须有这个：Claude Code 的 band 只在真实会话里渲染，我（模型）
// 看不到自己的输出。上一版就是纯靠想象设计的，结果条糊成一坨、图标没人认得。
// 现在 layoutRow / layoutPane 是纯函数，这里把它们输出的"段"涂上颜色，
// 所以浏览器里看到的排版 === 屏幕上的排版。
//
//   node tools/mock.mjs    → 写出 tools/mock.html

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computePace,
  dispWidth,
  layoutPane,
  layoutRow,
  normalize,
  scanForProviderKey,
  tierOf,
} from '../lib/quota.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://api.commandcode.ai';
const CONFIG_PATHS = [
  '.zcode/v2/provider_config.json',
  '.config/opencode/opencode.json',
  '.pi/agent/settings.json',
  '.claude/settings.json',
];
const KEY_SHAPE = /^(user_|cc_)[A-Za-z0-9_-]{8,}$/;

// 真实渲染器里这些是名字，浏览器里得给出具体色值。
// 分两套是刻意的：条用 ANSI 色（鲜明），文字与轨道用主题令牌（柔和、明暗自适应）。
const ANSI = { green: '#22c55e', yellow: '#eab308', red: '#ef4444' };
const TOKEN = {
  success: '#16a34a',
  warning: '#b45309',
  error: '#dc2626',
  'rate_limit_empty': '#e4e4e7',
};
// `ansi:` 前缀是给**引擎**看的：引擎只在 rgb( / # / ansi256( / ansi: 开头时
// 把值当颜色用，否则拿去查主题表、查不到就返回 undefined（完全不上色）。
// 浏览器不需要这个前缀，所以这里剥掉。以前 mock 只认裸色名，
// 结果**屏幕上色、视觉稿灰条** —— 视觉稿又一次和真机不一致。
const strip = (n) => (n && n.startsWith('ansi:') ? n.slice(5) : n);
const fg = (n) => (n ? TOKEN[n] || ANSI[strip(n)] || '#71717a' : null);
const bg = (n) => (n ? ANSI[strip(n)] || TOKEN[n] || null : null);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const seg = (s) => {
  if (s.kind === 'button') {
    return `<span class="btn">${esc(s.hotkey)} ${esc(s.label)}</span>`;
  }
  if (s.kind === 'input') {
    return `${esc(s.label || '')}<span class="field">${esc(s.placeholder || '')}</span><span class="btn">${esc(s.submitLabel || '')}</span>`;
  }
  if (s.kind === 'meter') {
    return s.parts
      .map(
        (p) =>
          `<span style="${p.color ? `color:${fg(p.color)};` : ''}${
            p.bg ? `background:${bg(p.bg)};` : ''
          }${p.dim ? 'opacity:.4;' : ''}">${esc(p.text)}</span>`,
      )
      .join('');
  }
  return `<span style="${fg(s.color) ? `color:${fg(s.color)};` : ''}${
    s.bold ? 'font-weight:700;' : ''
  }${s.dim ? 'opacity:.5;' : ''}">${esc(s.text)}</span>`;
};

// renderRow 在段之间插两个空格；mock 必须照做，否则我看到的比真实更挤
const rowHtml = (segs, sep = '  ') => segs.map(seg).join(esc(sep));

// 段的"实宽"：声明宽度与真实字形宽度取大者。
// 按钮 / 输入框由渲染器画自己的边框，声明宽度就是它占的位置，
// 光量文本会低估 —— 这正是以前看不出面板超宽的原因之一。
const segWidth = (s) => {
  let text;
  if (s.kind === 'button') text = s.hotkey + ' ' + s.label;
  else if (s.kind === 'input') text = (s.label || '') + (s.placeholder || '') + (s.submitLabel || '');
  else if (s.kind === 'meter') text = s.parts.map((p) => p.text).join('');
  else text = s.text;
  return Math.max(dispWidth(text), s.width || 0);
};

const rowWidth = (segs, gap) => segs.reduce((a, s) => a + segWidth(s), 0) + gap * Math.max(0, segs.length - 1);

// 把一行装进"恰好 cols 格"的框里。
// 为什么必须这么做：以前 .line 是 overflow-x:auto，浏览器自己横向回流，
// 于是 58 列的面板和 76 列的面板在视觉稿里**一样宽** —— 面板实际
// 比它声明的列数宽 12 格这件事，从来没被看出来过。框住之后溢出可见。
function frame(label, cols, segs, gap) {
  const w = rowWidth(segs, gap);
  const over = w > cols;
  return `<div class="cand">
  <div class="lbl">${esc(label)} · <span class="${over ? 'bad' : 'ok'}">实宽 ${w} / 可用 ${cols}${over ? ' · 超宽 ' + (w - cols) : ''}</span></div>
  <div class="line${over ? ' over' : ''}" style="width:calc(var(--cw) * ${cols})">${rowHtml(segs, gap === 0 ? '' : '  ')}</div>
</div>`;
}

async function main() {
  const demo = process.argv.includes('--demo');
  const now = Date.now();

  if (demo) {
    const raw = demoData();
    const v = normalize(raw, { now, apiBase: 'https://api.commandcode.ai' });
    emit(v, now, '合成数据（--demo），不含任何真实账号信息');
    return;
  }

  const cred = findCredential();
  if (!cred) {
    console.error('没找到 Command Code 凭据');
    process.exit(1);
  }
  // 默认拒绝用真实读数出图。这个工具的产物（tools/mock.html）就是拿来
  // 截图贴进 README 的，而真实读数一旦进了 docs/ 就跟着仓库一起公开了 ——
  // 这个仓库已经因为这类数据泄露重建过一次。合成数据请用 --demo。
  if (!process.argv.includes('--real')) {
    console.error('拒绝用真实账号读数生成视觉稿：那会把你的消费写进 tools/mock.html。');
    console.error('要合成数据用 --demo；确实要用真实读数，请显式加 --real。');
    process.exit(1);
  }
  const base = (cred.apiBase || API_BASE).replace(/\/+$/, '');
  const headers = { Authorization: 'Bearer ' + cred.apiKey, 'User-Agent': 'runway-mock/0.1.0' };
  const credits = await getJson(base + '/alpha/billing/credits', headers);
  const subs = await getJson(base + '/alpha/billing/subscriptions', headers);
  const since = subs && subs.data && subs.data.currentPeriodStart;
  const summary = await getJson(
    base + '/alpha/usage/summary' + (since ? '?since=' + encodeURIComponent(since) : ''),
    headers,
  );

  const v = normalize({ credits, subscription: subs, summary }, { now, apiBase: base });
  emit(v, now, `凭据 ${cred.via}`);
}

function emit(v, now, sourceNote) {
  const pace = computePace(v, now);
  const tier = tierOf(v, pace);

  // 带宽扫得细一点：降级是分段发生的（先掉条、再掉结论），
  // 只测 50/70/90 会正好跳过两个断点之间的所有中间态。
  const bandWidths = [160, 120, 100, 90, 80, 73, 70, 62, 58, 50, 40, 30, 26];
  const bandBlocks = bandWidths
    .map((c) => frame(`band · ${c} 列`, c, layoutRow(v, pace, tier, c, now, false), 2))
    .join(String.fromCharCode(10));

  const paneBlocks = [
    { c: 76, whatIf: null, note: '初始' },
    { c: 76, whatIf: '1.88', note: '试算了每天 $1.88' },
    { c: 58, whatIf: null, note: '面板声明的宽度' },
    { c: 34, whatIf: null, note: '极窄' },
  ]
    .map(({ c, whatIf, note }) => {
      const rows = layoutPane(v, pace, tier, c, now, false, whatIf);
      const body = rows
        .map((r) =>
          r.kind === 'gap'
            ? '<div class="gap"></div>'
            : `<div class="line${rowWidth(r.segs, 0) > c ? ' over' : ''}" style="width:calc(var(--cw) * ${c})">${rowHtml(r.segs, '')}</div>`,
        )
        .join('');
      const worst = Math.max(...rows.filter((r) => r.kind === 'row').map((r) => rowWidth(r.segs, 0)));
      const over = worst > c;
      return `<div class="cand">
  <div class="lbl">面板 · ${c} 列 · ${esc(note)} · <span class="${over ? 'bad' : 'ok'}">最宽行 ${worst}${over ? ' · 超宽 ' + (worst - c) : ''}</span></div>
  <div class="pane">${body}</div>
</div>`;
    })
    .join(String.fromCharCode(10));

  const html = `<!doctype html><meta charset="utf-8">
<style>
  :root{--cw:9px}
  body{background:#f4f4f5;margin:0;padding:26px 30px;
       font-family:"Cascadia Mono","Consolas","SF Mono",Menlo,monospace;}
  h1{font-size:13px;font-weight:600;color:#52525b;margin:0 0 6px;letter-spacing:.04em}
  .meta{font-size:11px;color:#a1a1aa;margin-bottom:22px}
  .cand{margin-bottom:20px}
  .lbl{font-size:11px;color:#71717a;margin-bottom:6px;font-weight:600}
  .lbl .ok{color:#16a34a}
  .lbl .bad{color:#dc2626}
  /* 框宽 = cols 个字符的宽度。超宽时内容会**溢出到框外**（不裁切）——
     这是刻意的：中文字体在浏览器里的字宽与终端的"列"并不严格相等，
     所以像素框只能给个大概，**权威信号是上面那行数字**（实宽 N / 可用 C）。
     裁切会让"没超"的行看起来也被切掉，反而误导。 */
  .line{background:#fafafa;border:1px solid #e4e4e7;border-radius:10px;
        padding:10px 13px;font-size:15px;line-height:1.55;white-space:pre;
        overflow:visible;box-sizing:content-box}
  .line.over{border-color:#dc2626;background:#fef2f2;box-shadow:0 0 0 3px #fecaca}
  .pane{background:#fafafa;border:1px solid #e4e4e7;border-radius:10px;padding:14px 16px}
  .pane .line{border:0;border-radius:0;background:none;padding:0;margin-bottom:1px}
  .pane .line.over{background:#fee2e2}
  .gap{height:8px}
  .btn{border:1px solid #d4d4d8;border-radius:5px;padding:0 5px;color:#52525b}
  .field{border:1px solid #a1a1aa;border-radius:5px;padding:0 6px;color:#a1a1aa;min-width:90px;display:inline-block}
</style>
<h1>runway · 真实布局的视觉稿</h1>
<div class="meta">由 layoutRow / layoutPane 直接输出 —— 与屏幕上渲染的是同一份布局代码。
每个框的宽度等于标注的列数，<span style="color:#dc2626">红框 = 内容比可用列数宽（会溢出框外）</span>。
判定以标注里的数字为准，框的像素宽度只给个大概 —— 中文字体的字宽与终端的"列"不严格相等。</div>
<h1 style="margin-bottom:12px">输入框上方的额度条</h1>
${bandBlocks}
<h1 style="margin:26px 0 12px">详情面板（按 1 打开）</h1>
${paneBlocks}

<script>
  // 量出一个 ASCII 字符在本机字体下的实际像素宽度，用它定义 --cw。
  // 不用 CSS 的 ch 单位：ch 是数字字宽，而布局是按"全角记 2 格"算的，
  // 两者在中文字体下并不相等，用 ch 框出来的列数和真实的格数对不上。
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:15px "Cascadia Mono","Consolas","SF Mono",Menlo,monospace';
  probe.textContent = '0'.repeat(100);
  document.body.appendChild(probe);
  document.documentElement.style.setProperty('--cw', (probe.getBoundingClientRect().width / 100) + 'px');
  probe.remove();
</script>
`;

  const out = path.join(HERE, 'mock.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('已写出', out);
  console.log('数据来源:', sourceNote);
  console.log('额度:', Math.round(v.monthly.percent) + '% 已用 · 档位:', tier.word);
}

function findCredential() {
  for (const name of ['COMMAND_CODE_API_KEY', 'COMMANDCODE_API_KEY', 'CMD_API_KEY']) {
    const v = process.env[name];
    if (v && KEY_SHAPE.test(v.trim())) return { apiKey: v.trim(), apiBase: null, via: 'env ' + name };
  }
  const home = os.homedir();
  for (const rel of CONFIG_PATHS) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(home, ...rel.split('/')), 'utf8'));
    } catch {
      continue;
    }
    const hit = scanForProviderKey(doc);
    if (hit) {
      return {
        apiKey: hit.apiKey,
        apiBase: hit.baseUrl.replace(/\/provider\/v\d+\/?$/, '').replace(/\/+$/, ''),
        via: rel,
      };
    }
  }
  return null;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 合成数据：给 README 截图、给别人演示用。
// 绝不要拿真实账号的读数去生成要公开的图 —— 那会泄露你自己的消费。
function demoData() {
  const now = Date.now();
  const start = new Date(now - 13 * 86400000).toISOString();
  const end = new Date(now + 17 * 86400000).toISOString();
  return {
    credits: {
      credits: { monthlyCredits: 33.6, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 0.42, cap: 14, exceeded: false, resetAt: now + 4.2 * 3600000 },
        weekly: { used: 5.6, cap: 35, exceeded: false, resetAt: now + 4.1 * 86400000 },
      },
    },
    subscription: { data: { status: 'active', planId: 'individual-goat', currentPeriodStart: start, currentPeriodEnd: end } },
    summary: { totalCost: 36.4, totalCount: 5000, averageCost: 0.00728 },
  };
}


main().catch((e) => {
  console.error('失败:', e.message || e);
  process.exit(1);
});
