#!/usr/bin/env node
// runway · 一键恢复「mod 加载通道」
//
//   node tools/restore-settings.mjs            # 检查 + 修（会先备份）
//   node tools/restore-settings.mjs --dry-run  # 只看要改什么，不落盘
//
// 为什么需要它：
// `~/.claude/settings.json` 是**多个写入方共用**的一个文件。桌面应用在按它自己
// 那份状态整份覆盖时，会把别人写进去的键（mod 的 `enabledPlugins`、我们那条
// `env.CLAUDE_CODE_PLUGIN_DIRS`）**一起抹掉** —— 表现就是"mod 突然全不见了"，
// 而 settings 里一行错都没有。已经发生过两次。
//
// 这个脚本把丢掉的键补回去，且**只碰这两个键**：其余原样保留。
// 幂等：已经是好的就什么都不做。
//
// ⚠️ 任何情况下都不打印凭据 —— 这个文件里可能有 token，构建输出时只报键名。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_DIR = path.resolve(HERE, '..'); // 插件根目录（本文件在 tools/ 下）
const MARKETPLACE = 'claude-code-playground-mods';
// 和 runway 一起从同一个 marketplace 装、同样会被抹掉的邻居
const SIBLINGS = ['token-weather', 'replay-theater'];

const SETTINGS = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
const dryRun = process.argv.includes('--dry-run');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    console.error(`读不了 ${SETTINGS}：${err.message}`);
    process.exit(2);
  }
}

function main() {
  const doc = readSettings();
  const changes = [];

  // 1) 本机目录型 mod：CLAUDE_CODE_PLUGIN_DIRS 必须指向本插件根目录
  const wantDir = MOD_DIR.replace(/\\/g, '/');
  const env = doc.env || (doc.env = {});
  if (env.CLAUDE_CODE_PLUGIN_DIRS !== wantDir) {
    changes.push(
      `env.CLAUDE_CODE_PLUGIN_DIRS: ${JSON.stringify(env.CLAUDE_CODE_PLUGIN_DIRS ?? null)} → ${JSON.stringify(wantDir)}`,
    );
    env.CLAUDE_CODE_PLUGIN_DIRS = wantDir;
  }

  // 2) marketplace 型 mod：enabledPlugins 里每个都要是 true
  //
  // **不要**把 runway 自己也塞进来 —— 它是**目录型**加载的（靠上面那条
  // CLAUDE_CODE_PLUGIN_DIRS）。两个通道都注册同一个 mod 会让它画两遍。
  const ep = doc.enabledPlugins || (doc.enabledPlugins = {});
  for (const name of SIBLINGS) {
    const id = `${name}@${MARKETPLACE}`;
    if (ep[id] !== true) {
      changes.push(`enabledPlugins["${id}"]: ${JSON.stringify(ep[id] ?? null)} → true`);
      ep[id] = true;
    }
  }

  if (!changes.length) {
    console.log('✔ 加载通道完好，什么都不用改。');
    console.log(`  CLAUDE_CODE_PLUGIN_DIRS = ${wantDir}`);
    console.log(`  （runway 走目录型加载；enabledPlugins 里是 ${SIBLINGS.join(' / ')}）`);
    return;
  }

  console.log(`${dryRun ? '（dry-run）' : ''}要补回 ${changes.length} 处：`);
  for (const c of changes) console.log('  · ' + c);

  if (dryRun) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${SETTINGS}.bak-before-mod-restore-${stamp}`;
  fs.copyFileSync(SETTINGS, bak);
  console.log(`已备份 → ${path.basename(bak)}`);

  fs.writeFileSync(SETTINGS, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  // 写完立刻复读一遍，确认真的落盘了（这个文件被别的进程抢写过太多次）
  const back = readSettings();
  const ok =
    back.env?.CLAUDE_CODE_PLUGIN_DIRS === wantDir &&
    SIBLINGS.every((n) => back.enabledPlugins?.[`${n}@${MARKETPLACE}`] === true);
  if (!ok) {
    console.error('✘ 写回去又被改了 —— 有别的进程正在覆盖这个文件，稍后重试。');
    process.exit(1);
  }
  console.log('✔ 补回完成。**要重启应用**才会重新加载 mod。');
}

main();
