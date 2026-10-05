#!/usr/bin/env node
// runway · 预览工具
//
// 不走 Claude Code，直接跑一遍「找凭据 → 调接口 → 归一化 → 布局」，把结果打成文本。
// 用途：改布局时快速看效果；取不到数时定位卡在哪一步。
//
//   node tools/preview.mjs           # 取数并打印额度条 / 面板 / 命令输出
//   node tools/preview.mjs --json    # 额外 dump 归一化后的对象
//
// 它和 hooks 模块共用 lib/quota.mjs 里的 layoutRow / layoutPane，
// 所以这里看到的排版和屏幕上的是同一份。唯一重复的是凭据发现中「读文件」那一小段
// （hooks 里用 $.fs.read，这里用 node:fs，没法共用）。
//
// 想要带颜色的视觉稿：node tools/mock.mjs，然后打开 tools/mock.html。

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
  snapshotText,
  tierOf,
} from '../lib/quota.mjs';
import { buildCatalog, catalogAge, catalogDiff, catalogUrl, parsePlanEstimates } from '../lib/catalog.mjs';

const API_BASE = 'https://api.commandcode.ai';
const CONFIG_PATHS = [
  '.zcode/v2/provider_config.json',
  '.config/opencode/opencode.json',
  '.pi/agent/settings.json',
  '.claude/settings.json',
];
const KEY_SHAPE = /^(user_|cc_)[A-Za-z0-9_-]{8,}$/;

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
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// 段 → 纯文本（丢掉颜色，终端里看的是排版）
const segText = (s) => {
  if (s.kind === 'button') return s.hotkey + ' ' + s.label;
  if (s.kind === 'meter') return s.parts.map((p) => p.text).join('');
  // 输入框（试算）以前落到 `return s.text`，而它没有 text —— 于是预览里
  // 「试算」后面是一片空白，看着像那行坏了。
  if (s.kind === 'input') return '[' + s.label + s.placeholder + ' ▸' + s.submitLabel + ']';
  return s.text;
};

// 按显示宽度算 —— 直接用布局层那一份，别再实现一遍。
// （以前这里自己写了个 `codePointAt(0) > 0x2e7f ? 2 : 1`，
//   与 lib 的 dispWidth 是两套规则，迟早会漂移。）
const width = (s) => dispWidth(s);

async function main() {
  const cred = findCredential();
  if (!cred) {
    console.error('没找到 Command Code 凭据。查过这些位置：');
    for (const rel of CONFIG_PATHS) console.error('  ~/' + rel);
    process.exit(1);
  }
  // 只报来源就够。以前这里还会打印 "key 长度 N，前缀 user_…" ——
  // 调试输出没必要出现凭据的任何片段，何况这个工具的输出常被贴来贴去。
  console.log(`凭据  来自 ${cred.via}`);

  const base = (cred.apiBase || API_BASE).replace(/\/+$/, '');
  const headers = {
    Authorization: 'Bearer ' + cred.apiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'runway-preview/0.1.0',
  };
  console.log(`接口  ${base}`);

  const t0 = Date.now();
  // 三个请求并行，跟 mod 里 `refresh()` 的做法一致 ——
  // `since` 与不传等价（实测：不传返回的就是当前计费周期），所以 summary 不必等 subscriptions。
  // （这里以前是三个 await 串行，而打印出来的说明却写着"并行"，说明本身是错的。）
  const [credits, subs, summary] = await Promise.all([
    getJson(base + '/alpha/billing/credits', headers),
    getJson(base + '/alpha/billing/subscriptions', headers),
    getJson(base + '/alpha/usage/summary', headers),
  ]);
  console.log(`耗时  ${Date.now() - t0} ms（三个请求并行）`);

  const now = Date.now();
  const v = normalize({ credits, subscription: subs, summary }, { now, apiBase: base });
  const pace = computePace(v, now);
  const tier = tierOf(v, pace);

  // 模型次数目录 —— 跟 mod 一样抓公开文档页的 RSC 流。
  // 以前预览不抓，`layoutPane` 拿不到 `catalog`，于是**那张模型表在这份预览里
  // 根本不出现**：自检工具恰好绕开了用户最关心的一块。
  let catalog = null;
  let catDiff = null;
  const planId = subs && subs.data && subs.data.planId;
  const docUrl = catalogUrl(planId);
  if (docUrl) {
    try {
      const res = await fetch(docUrl, {
        headers: { RSC: '1', 'User-Agent': 'runway-preview/0.1.0' },
      });
      if (res.ok) {
        catalog = buildCatalog(parsePlanEstimates(await res.text()), planId, Date.now());
        catDiff = catalogDiff(null, catalog);
      }
    } catch {
      // 抓不到就不画那块 —— 和真机上目录为空时一样
    }
  }
  console.log(
    `模型表 ${catalog ? catalog.models.length + ' 个 · 官方 ' + catalogAge(catalog, Date.now()) : '（没抓到，面板里不显示）'}`,
  );

  console.log('');
  console.log('──── 输入框上方的额度条 ────');
  console.log('');
  for (const cols of [160, 120, 90, 80, 73, 70, 62, 58, 50, 40, 30, 26]) {
    const segs = layoutRow(v, pace, tier, cols, now, false);
    const line = segs.map(segText).join('  ');
    // band 里还存在的可丢段：会员名 + 三根条。以前这里列着一个 `foot`，
    // 而 `foot` 早就不存在了 —— 于是每行都假报「已丢 foot」。
    const gone = ['plan', 'fivebar', 'weekbar', 'monbar'].filter(
      (id) => !segs.some((s) => s.id === id),
    );
    console.log(String(cols).padStart(3) + ' 列 │ ' + line);
    console.log('      └ 实宽 ' + width(line) + (gone.length ? '   已丢: ' + gone.join(', ') : ''));
  }

  console.log('');
  console.log('──── 详情面板（按 1 打开）────');
  // 两个宽度都打：面板的 `columns: 78` 只是**请求值**，窄窗口 / 用户拖动之后
  // 实际可能窄得多，而侧边栏才是常态 —— 所以窄的那个也要看。
  for (const cols of [58, 40]) {
    console.log('');
    console.log('  ── ' + cols + ' 列' + (cols === 40 ? '（很窄）' : '（侧边栏常见）') + ' ──');
    console.log('');
    for (const r of layoutPane(v, pace, tier, cols, now, false, null, { catalog, diff: catDiff })) {
      if (r.kind === 'gap') {
        console.log('');
        continue;
      }
      const line = r.segs.map(segText).join('');
      const w = r.segs.reduce((a, s) => a + s.width, 0);
      console.log('  ' + line + (w > cols ? '   ⚠ 超宽 ' + w + ' > ' + cols : ''));
    }
  }

  console.log('');
  console.log('──── /quota 命令的输出 ────');
  console.log('');
  console.log(
    snapshotText(v, now)
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );

  if (process.argv.includes('--json')) {
    console.log('');
    console.log('──── 归一化后的对象 ────');
    console.log('');
    console.log(JSON.stringify(v, null, 2));
  }
}

main().catch((err) => {
  console.error('失败:', err && err.message ? err.message : err);
  process.exit(1);
});
