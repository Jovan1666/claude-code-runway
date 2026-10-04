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
  const credits = await getJson(base + '/alpha/billing/credits', headers);
  const subs = await getJson(base + '/alpha/billing/subscriptions', headers);
  const since = subs && subs.data && subs.data.currentPeriodStart;
  const summary = await getJson(
    base + '/alpha/usage/summary' + (since ? '?since=' + encodeURIComponent(since) : ''),
    headers,
  );
  console.log(`耗时  ${Date.now() - t0} ms（credits 与 subscriptions 并行，summary 串行）`);

  const now = Date.now();
  const v = normalize({ credits, subscription: subs, summary }, { now, apiBase: base });
  const pace = computePace(v, now);
  const tier = tierOf(v, pace);

  console.log('');
  console.log('──── 输入框上方的额度条 ────');
  console.log('');
  for (const cols of [160, 120, 90, 80, 73, 70, 62, 58, 50, 40, 30, 26]) {
    const segs = layoutRow(v, pace, tier, cols, now, false);
    const line = segs.map(segText).join('  ');
    const gone = ['foot', 'fivebar', 'weekbar', 'monbar'].filter(
      (id) => !segs.some((s) => s.id === id),
    );
    console.log(String(cols).padStart(3) + ' 列 │ ' + line);
    console.log('      └ 实宽 ' + width(line) + (gone.length ? '   已丢: ' + gone.join(', ') : ''));
  }

  console.log('');
  console.log('──── 详情面板（按 1 打开）────');
  console.log('');
  for (const r of layoutPane(v, pace, tier, 58, now, false)) {
    console.log(r.kind === 'gap' ? '' : '  ' + r.segs.map(segText).join(''));
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
