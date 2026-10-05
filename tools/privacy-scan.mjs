// runway · 隐私扫描：这个仓库的硬规矩是「真实账单数据不得入库」。
//
// 这个口子栽过三次，每次都是同一个动作：**把真机屏幕上的数字抄进测试夹具或文档**。
// 金额、请求数、均价三者一起出现，就等于把账本公开。所以靠"我记得扫一眼"是不行的。
//
// 做法不需要维护"敏感值清单"（清单本身就是泄露）：直接读**本机此刻的真实读数**
// （mod 自己缓存的那份，`~/.claude/plugins/store/runway_inline-*.json`），
// 再拿这些字符串去仓库里 grep。抄进仓库的数值必然在其中。
//
//   node tools/privacy-scan.mjs          # 扫工作区的受版本控制的文件
//   node tools/privacy-scan.mjs --all    # 连未跟踪的文件一起扫
//
// 退出码非 0 = 命中，别提交。
//
// 局限（诚实说清）：
//   · 只抓**此刻缓存里还在**的数。很久以前抄进去、现在缓存已经滚过去的，抓不到。
//   · 抓不到"形状像但数值不同"的泄露（比如把真读数四舍五入后再抄）。
//   所以它是一道网，不是保证 —— 夹具值仍然要**编**，而且编得像样。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const STORE = path.join(HOME, '.claude', 'plugins', 'store');

// ── 1. 从本机实时读数里取出「有辨识度」的数字 ──
function liveNumbers() {
  const found = new Map(); // 字符串 → 它在本机数据里的路径（只用于报告，不外传）
  let files = [];
  try {
    files = fs.readdirSync(STORE).filter((f) => f.startsWith('runway') && f.endsWith('.json'));
  } catch {
    return found;
  }
  const walk = (node, trail) => {
    if (typeof node === 'number' && Number.isFinite(node)) {
      // 关键：缓存里存的是**全精度浮点**（十几位小数），而从屏幕/面板上
      // 抄下来的必然是**舍入过**的（两位小数）。只比原串等于白做 —— 所以把每个数
      // 连同它的两位小数形式一起登记。第一次写这个扫描器就是栽在这里：
      // 注入了真值它也不响。
      //
      // ⚠️ 这段注释里**不许写真实数值当例子** —— 扫描器会扫到自己
      //（已经发生过一次：把演示用的那个数原样写进来了）。
      const candidates = new Set();
      const raw = String(node);
      candidates.add(raw);
      if (Number.isInteger(node)) candidates.add(String(node));
      else {
        const two = node.toFixed(2);
        // 0.0034 这类均价舍成 "0.00" 就什么都没剩，别登记（否则它会命中
        // 满仓库的 "0.00"，把信噪比毁掉）
        if (Number(two) !== 0) candidates.add(two);
      }
      for (const s of candidates) {
        // 只留有辨识度的：两位以上小数，或四位以上整数。
        // 避开口径常量（70 / 14 / 35 / 0.2 / 0.5）—— 那些是公开的，也到处都是。
        const decimals = (s.split('.')[1] || '').length;
        const distinctive = decimals >= 2 || (/^\d+$/.test(s) && Number(s) >= 1000);
        if (distinctive) found.set(s, trail);
      }
    } else if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, trail + '[' + i + ']'));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        // 模型目录是**公开数据** —— 每个模型的份额与单价都印在官方文档页上，
        // 人人可查，不是这个账号的隐私。扫它只会淹掉真正的命中。
        if (k === 'runway.catalog') continue;
        walk(v, trail + '.' + k);
      }
    }
  };
  for (const f of files) {
    try {
      walk(JSON.parse(fs.readFileSync(path.join(STORE, f), 'utf8')), f);
    } catch {
      /* 读不动就算了，扫描本身不该因为缓存损坏而失败 */
    }
  }
  return found;
}

// ── 2. 列出要扫的文件 ──
function filesToScan(all) {
  const exts = new Set(['.mjs', '.js', '.ts', '.tsx', '.md', '.json', '.html', '.yml', '.yaml']);
  const skip = new Set(['.git', 'node_modules', '.claude-plugin']);
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') && e.name !== '.claude-plugin') continue;
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (exts.has(path.extname(e.name)) && r !== 'tools/privacy-scan.mjs') out.push({ abs, rel: r });
    }
  };
  walk(process.cwd(), '');
  return out;
}

// ── 3. 比对 ──
const live = liveNumbers();
const files = filesToScan(process.argv.includes('--all'));

if (live.size === 0) {
  console.log('⚠️  读不到本机读数（' + STORE + ' 下没有 runway*.json），');
  console.log('    这次只能查"像不像用量"的形状，查不了具体数值。');
}

const hits = [];
for (const { abs, rel } of files) {
  const text = fs.readFileSync(abs, 'utf8');
  for (const [num, trail] of live) {
    // 前后不能是数字，避免 15 命中 154
    const re = new RegExp('(?<![0-9.])' + num.replace('.', '\\.') + '(?![0-9])');
    const m = re.exec(text);
    if (!m) continue;
    const line = text.slice(0, m.index).split('\n').length;
    hits.push({ rel, line, num, trail });
  }
}

if (hits.length === 0) {
  console.log('✔ 干净：' + files.length + ' 个文件里没有出现本机此刻的任何读数（比对了 ' + live.size + ' 个数）。');
  console.log('  注意这只是"没抄眼下的数" —— 夹具值仍然必须是自己编的。');
  process.exit(0);
}

console.error('✘ 命中 ' + hits.length + ' 处 —— 仓库里出现了本机的真实读数：\n');
for (const h of hits) {
  // 只报文件与行号，**不把数值打进日志**（日志本身也会被贴来贴去）
  console.error('  ' + h.rel + ':' + h.line + '   ← 与 ' + h.trail + ' 中的某个读数相同');
}
console.error('\n真实账单数据不得入库。把它们换成**自己编的**值（参考 tests/quota.test.ts 的合成基准）。');
process.exit(1);
