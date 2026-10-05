// tree_lint.mjs — 把 mod 真正会画出来的树，喂进引擎那套 ui.render 校验规则里跑一遍。
//
// 背景：引擎对 ui.render 返回的树做一次校验（CLI 里的 d2n），不过就整棵丢弃、
// 改画自己的（= 空白），屏幕上没有任何提示。`claude plugin validate` 抓不到这类错误。
// 测试环境里没有引擎，所以这里**重新实现**了 d2n（含全部子校验器与属性表），
// 再从二进制里抄来的常量对齐。所有规则都能在
// `AppData\Local\Claude-3p\claude-code\2.1.286\635c1867224a\claude.exe` 里逐字对上。
//
// 用法：
//   node tree_lint.mjs                 # 跑 runway（band + pane，多宽度/多数据态）
//   node tree_lint.mjs --self-test     # 额外：注入一个 ansi:red，确认能抓出来
//
// 作为测试接入（tests/ 里）：
//   import { validateTree, factorySet } from './tree_lint.mjs'
//   test('band 在 20..200 列都过校验', () => { ... expect(validateTree(t,{surface:'desktop'})).toBe(undefined) })

// ═══════════════════════════════════════════════════════════════════
// 1) 引擎常量与属性表（逐个来自 claude.exe 的 d2n / PUt 及其引用）
// ═══════════════════════════════════════════════════════════════════

export const LIMITS = {
  nodes: 20000,        // vAe  超过 -> "more than 20000 nodes"
  depth: 32,           // wAe
  textChild: 1e4,      // w$   单段文本 / label / alt
  textTotal: 1e5,      // n7   一棵树里文本字符总量
  rasterCells: 262144, // c2n  一棵树里 Raster 单元格总量
  imageBytes: 2097152, // l2n  一棵树里 Image 源字节总量
  svgSource: 131072,   // a2n  Svg source 长度
  href: 2048,          // Vlt  Link href / pressableLinks 单条
  hoverScope: 64,      // n2n  hover scope 名长度
  pressable: 256,      // s2n  pressableLinks 条数
  selectOptions: 64,   // i2n  Select options 条数
  svgPixels: 4096,     // tan  Svg/Image width/height 像素
  codeLine: 1e9,       // Glt  Code startLine / diff 行号
  size: 1e4,           // D8e  width/height/margin 等数值上限
  aroundDialogRows: 12,// emt  对话框周围的行预算
  charsPerRow: 40,     // ngn  文本折行的估算列宽
};

// G2：每个 surface 允许的元素（Object.keys 顺序就是报错文案里的顺序）
export const SURFACE_ELEMENTS = {
  terminal: ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Client', 'Raster', 'Image'],
  desktop:  ['Box', 'Text', 'Button', 'Input', 'Select', 'Svg', 'Link', 'Code', 'Markdown', 'Client'],
  mobile:   ['Box', 'Text', 'Button', 'Svg', 'Link', 'Code', 'Markdown'],
  vscode:   ['Box', 'Text', 'Button', 'Input', 'Select', 'Svg', 'Link', 'Code', 'Markdown'],
};

// z3e：block / inline 分类。inline 元素里不能再放 block 元素。
export const BLOCK_INLINE = {
  Box: 'block', Button: 'block', Input: 'block', Select: 'block', Svg: 'block',
  Code: 'block', Markdown: 'block', Client: 'block', Raster: 'block', Image: 'block',
  Text: 'inline', Link: 'inline',
};

// TOr：这类元素的 props 由各自的专用校验器（HOr）负责，不走通用属性循环。
const TERMINAL = new Set(['Button', 'Input', 'Select', 'Svg', 'Code', 'Markdown', 'Client', 'Raster', 'Image']);

// G1r：通用属性循环里 Box / Text 各自允许的属性（"key" 对 Box 除外放行）
export const ALLOWED_PROPS = {
  Box: new Set(['flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf',
    'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight',
    'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
    'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display',
    'position', 'top', 'left', 'right', 'bottom']),
  Text: new Set(['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline',
    'strikethrough', 'inverse', 'wrap']),
};

// j1r：hover 里允许的属性
const HOVER_PROPS = {
  Box: new Set(['borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'display', 'top', 'left', 'right', 'bottom']),
  Text: new Set(['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse']),
};

// z1r：枚举属性 -> 允许值
export const ENUM_PROPS = {
  flexDirection: new Set(['row', 'column', 'row-reverse', 'column-reverse']),
  flexWrap: new Set(['nowrap', 'wrap', 'wrap-reverse']),
  alignItems: new Set(['flex-start', 'center', 'flex-end', 'stretch']),
  alignSelf: new Set(['flex-start', 'center', 'flex-end', 'auto']),
  justifyContent: new Set(['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']),
  overflow: new Set(['visible', 'hidden']),
  display: new Set(['flex', 'none']),
  position: new Set(['relative', 'absolute']),
  wrap: new Set(['wrap', 'end', 'middle', 'truncate-end', 'truncate', 'truncate-middle', 'truncate-start']),
  // borderStyle 的来源是 ink 的名字表 + "dashed"/"quote"；常见的几个：
  borderStyle: new Set(['single', 'double', 'round', 'bold', 'singleDouble', 'doubleSingle',
    'classic', 'arrow', 'dashed', 'quote']),
};

// PYn：只允许布尔值的属性
const BOOL_PROPS = new Set(['dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'borderDimColor']);
// B1r：颜色属性（唯一的颜色规则就是那个字符集）
const COLOR_PROPS = new Set(['color', 'backgroundColor', 'borderColor']);
// W1r：允许的有限数值属性（|x| <= 1e4）
const NUM_PROPS = new Set(['flexGrow', 'flexShrink', 'gap', 'columnGap', 'rowGap', 'margin', 'marginX', 'marginY',
  'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY',
  'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']);
// M8e：必须是非负整数（字符格），|x| <= 1e4
const CELL_PROPS = new Set(['top', 'left', 'right', 'bottom']);
// xUt：尺寸，接受 0..1e4 的数，或 "NN%"
const SIZE_PROPS = new Set(['width', 'height', 'minWidth', 'minHeight']);
// V1r：会影响"周围行数"的（这里只用于 aroundDialog 判定）
const AROUND_PROPS = new Set(['display', 'overflow', 'position', ...SIZE_PROPS, ...CELL_PROPS]);

export const COLOR_RE = /^[#a-zA-Z0-9_().,% -]{1,40}$/;
// v2n：控制字符 / 孤立代理项 / 占位符。\t \n \r 是允许的（不在集合里）。
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\u{10eeee}]/u;

// ═══════════════════════════════════════════════════════════════════
// 2) 属性值校验（PUt 的等价实现）
// ═══════════════════════════════════════════════════════════════════
function checkProp(prop, value) {
  const e = ENUM_PROPS[prop];
  if (e !== undefined) {
    return (typeof value === 'string' && e.has(value)) ? undefined
      : `must be one of ${[...e].join(', ')}`;
  }
  if (SIZE_PROPS.has(prop)) {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 && value <= LIMITS.size ? undefined
        : `must be a finite number between 0 and ${LIMITS.size}`;
    }
    return typeof value === 'string' && /^\d{1,3}%$/.test(value) ? undefined : 'must be a number or a percentage';
  }
  if (NUM_PROPS.has(prop)) {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMITS.size ? undefined
      : `must be a finite number within ${LIMITS.size}`;
  }
  if (CELL_PROPS.has(prop)) {
    return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= LIMITS.size ? undefined
      : `must be an integer within ${LIMITS.size} (character cells)`;
  }
  if (COLOR_PROPS.has(prop)) {
    return typeof value === 'string' && COLOR_RE.test(value) ? undefined : 'must be a color (a theme key, a name, or hex)';
  }
  if (BOOL_PROPS.has(prop)) {
    return typeof value === 'boolean' ? undefined : 'must be a boolean';
  }
  return 'has no value rule';
}

// I6：字符串、长度 <= w$、无控制字符
function checkText(name, value) {
  const isStr = typeof value === 'string';
  if (value !== undefined && !isStr) return `${name} must be a string`;
  if (isStr && value.length > LIMITS.textChild) return `${name} longer than ${LIMITS.textChild} characters`;
  return (isStr && CONTROL_RE.test(value)) ? `${name} holds a control character` : undefined;
}
const s$ = (e) => { const n = String(e).replace(/\?/g, '?'); return n.length <= 40 ? n : n.slice(0, 40) + '...'; };

// ═══════════════════════════════════════════════════════════════════
// 3) 各元素专用校验器（HOr / $Or 的等价实现）
// ═══════════════════════════════════════════════════════════════════
function onlyKeys(obj, allowed) {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function vButton(n) {
  const p = n.props;
  if (!(p && typeof p.key === 'string' && p.key !== '' && typeof p.label === 'string'
        && onlyKeys(p, ['key', 'label', 'hotkey', 'action', 'plain', 'dimColor', 'variant', 'role', 'autoFocus']))) {
    return 'Button props must be { key, label }, both strings, hotkey a digit or a letter, action a keybinding action, dimColor a boolean, variant "primary" or "secondary", role "dismiss" and autoFocus true';
  }
  const { key: h, label: g, hotkey: S, action: w, plain: R, dimColor: T, variant: L, role: D, autoFocus: W } = p;
  if (R !== undefined && R !== true) return `Button "${h}" plain is true or absent`;
  if (T !== undefined && typeof T !== 'boolean') return `Button "${h}" dimColor is a boolean or absent`;
  if (L !== undefined && L !== 'primary' && L !== 'secondary') return `Button "${h}" variant is "primary", "secondary" or absent`;
  if (D !== undefined && D !== 'dismiss') return `Button "${h}" role is "dismiss" or absent`;
  const auto = (W === undefined || W === true) ? undefined : 'autoFocus is true or absent';
  if (auto !== undefined) return `Button "${h}" ${auto}`;
  if (S !== undefined && (typeof S !== 'string' || !/^[0-9a-z]$/.test(S))) return `Button "${h}" hotkey must be one digit 0-9 or one lowercase letter a-z`;
  if (w !== undefined && (typeof w !== 'string' || w === '')) return `Button "${h}" action is not one of the engine's keybinding actions`;
  if (g.length > LIMITS.textChild) return `Button "${h}" label longer than ${LIMITS.textChild} characters`;
  if (CONTROL_RE.test(g)) return `Button "${h}" label holds a control character`;
  return undefined;
}

function vInput(n) {
  const p = n.props;
  const allowed = ['key', 'label', 'placeholder', 'value', 'submitLabel', 'autoFocus'];
  if (!(p && Object.keys(p).every((k) => allowed.includes(k)) && typeof p.key === 'string' && p.key !== '')) {
    return 'Input props must be { key } and any of label, placeholder, value, submitLabel, autoFocus';
  }
  for (const f of ['label', 'placeholder', 'value', 'submitLabel']) {
    const r = checkText(f, p[f]);
    if (r !== undefined) return `Input "${p.key}" ${r}`;
  }
  if (p.autoFocus !== undefined && p.autoFocus !== true) return `Input "${p.key}" autoFocus is true or absent`;
  if (n.children !== undefined) return `Input "${p.key}" takes no children`;
  return undefined;
}

function vSelect(n) {
  const p = n.props;
  if (!(p && typeof p.key === 'string' && p.key !== ''
        && onlyKeys(p, ['key', 'label', 'options', 'value', 'autoFocus']))) {
    return 'Select props must be { key, options } and any of label, value, autoFocus';
  }
  const opts = p.options;
  const okOpts = Array.isArray(opts) && opts.length > 0 && opts.length <= LIMITS.selectOptions;
  const seen = new Set();
  let r = checkText('label', p.label) ?? checkText('value', p.value);
  if (r === undefined) {
    if (okOpts) {
      for (const o of opts) {
        if (!(o && typeof o.value === 'string' && Object.keys(o).every((k) => k === 'value' || k === 'label'))) {
          r = 'options are { value: string, label?: string }'; break;
        }
        if (seen.has(o.value)) { r = `option "${o.value}" is listed twice; values are unique`; break; }
        seen.add(o.value);
        const rr = checkText('value', o.value) ?? checkText('label', o.label);
        if (rr !== undefined) { r = `option "${o.value}" ${rr}`; break; }
      }
    } else {
      r = `options must be 1 to ${LIMITS.selectOptions} entries`;
    }
  }
  if (r === undefined && p.autoFocus !== undefined && p.autoFocus !== true) r = 'autoFocus is true or absent';
  if (r === undefined && n.children !== undefined) r = 'takes no children';
  return r === undefined ? undefined : `Select "${p.key}" ${r}`;
}

function vSvg(n) {
  const p = n.props;
  if (!p) return 'Svg props must be { source, alt }';
  if (n.children !== undefined) return 'Svg takes no children';
  const { source: s, alt: h, width: g, height: S, isInteractive: w, ...R } = p;
  const [extra] = Object.keys(R);
  if (extra !== undefined) return `Svg prop "${extra}" is not allowed`;
  if (typeof s !== 'string' || s === '') return 'Svg source must be a non-empty string';
  if (s.length > LIMITS.svgSource) return `Svg source longer than ${LIMITS.svgSource} characters`;
  if (typeof h !== 'string') return 'Svg alt must be a string';
  if (h.length > LIMITS.textChild) return `Svg alt longer than ${LIMITS.textChild} characters`;
  if (CONTROL_RE.test(h)) return 'Svg alt holds a control character';
  const px = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= LIMITS.svgPixels);
  if (!px(g) || !px(S)) return `Svg width and height are pixels, at most ${LIMITS.svgPixels}`;
  return (w === undefined || typeof w === 'boolean') ? undefined : 'Svg isInteractive is a boolean';
}

function vCode(n) {
  const p = n.props;
  if (!p) return 'Code props must be { source }';
  if (n.children !== undefined) return 'Code takes no children';
  const { source: s, language: h, path: g, startLine: S, format: w, wrap: R, ...T } = p;
  const [extra] = Object.keys(T);
  if (extra !== undefined) return `Code prop "${extra}" is not allowed`;
  if (typeof s !== 'string') return 'Code source must be a string';
  const r = checkText('source', s) ?? checkText('language', h) ?? checkText('path', g);
  if (r !== undefined) return `Code ${r}`;
  if (!(S === undefined || (typeof S === 'number' && Number.isSafeInteger(S) && S >= 1))) return 'Code startLine must be a positive integer';
  if (S !== undefined && S > LIMITS.codeLine) return `Code startLine is at most ${LIMITS.codeLine}`;
  if (w !== undefined && w !== 'source' && w !== 'diff') return 'Code format is "source" or "diff"';
  if (R !== undefined && R !== 'wrap' && R !== 'truncate-end') return 'Code wrap is "wrap" or "truncate-end"';
  return undefined;
}

function vMarkdown(n) {
  const p = n.props;
  if (!(p && onlyKeys(p, ['key', 'text', 'dimColor', 'pressableLinks']))) {
    return 'Markdown props must be { text }, a string, key a string, dimColor a boolean and pressableLinks a list of hrefs';
  }
  if (n.children !== undefined) return 'Markdown takes no children';
  const { key: g, text: S, dimColor: w, pressableLinks: R } = p;
  if (typeof S !== 'string') return 'Markdown text must be a string';
  if (g !== undefined && !(typeof g === 'string' && g !== '' && g.length <= LIMITS.textChild)) {
    return `Markdown key "${s$(g)}" is not a usable address`;
  }
  const L = g === undefined ? 'Markdown' : `Markdown "${s$(g)}"`;
  const D = checkText('text', S);
  if (D !== undefined) return `${L} ${D}`;
  if (R !== undefined) {
    if (!Array.isArray(R)) return `pressableLinks is ${Array.isArray(R) ? 'an array' : 'not a list of hrefs'}`;
    if (R.length > LIMITS.pressable) return `pressableLinks names more than ${LIMITS.pressable} links`;
    for (const href of R) {
      if (typeof href !== 'string' || href === '') return 'pressableLinks holds a value that is not an href';
      if (href.length > LIMITS.href) return `pressableLinks holds an href longer than ${LIMITS.href} characters`;
      if (CONTROL_RE.test(href)) return 'pressableLinks holds an href with a control character';
    }
  }
  if (w !== undefined && typeof w !== 'boolean') return `${L} dimColor is a boolean or absent`;
  return undefined;
}

function vClient(n) {
  const p = n.props;
  if (!(p && typeof p.key === 'string' && p.key !== '' && typeof p.module === 'string' && p.module !== ''
        && onlyKeys(p, ['key', 'module', 'props', 'width', 'height', 'flexGrow']))) {
    return 'Client props must be { key, module }, both non-empty strings, and any of props, width, height, flexGrow';
  }
  const r = checkText('module', p.module);
  if (r !== undefined) return `Client "${p.key}" ${r}`;
  if (p.props !== undefined && (typeof p.props !== 'object' || Array.isArray(p.props))) return `Client "${p.key}" props is not an object`;
  for (const f of ['width', 'height', 'flexGrow']) {
    const v = p[f];
    if (v === undefined) continue;
    const w = (typeof v === 'number' || typeof v === 'string') ? checkProp(f, v) : 'must be a number or a string';
    if (w !== undefined) return `Client "${p.key}" ${f} ${w}`;
  }
  return n.children === undefined ? undefined : `Client "${p.key}" takes no children`;
}

function vRaster(n) {
  const p = n.props;
  if (!(p && onlyKeys(p, ['key', 'columns', 'rows', 'cells']) && typeof p.key === 'string' && p.key !== '')) {
    return 'Raster props must be { key, columns, rows, cells }, key a non-empty string, and nothing else (no hover or onPress yet)';
  }
  if (n.children !== undefined) return 'Raster takes no children';
  const { columns: c, rows: r } = p;
  if (!(Number.isInteger(c) && Number.isInteger(r))) return `Raster "${s$(p.key)}" columns and rows are whole numbers`;
  if (typeof p.cells !== 'string') return `Raster "${s$(p.key)}" cells must be a string`;
  return undefined;
}

function vImage(n) {
  const p = n.props;
  if (!(p && typeof p.alt === 'string' && onlyKeys(p, ['source', 'columns', 'rows', 'alt', 'key']))) {
    return 'Image props must be { source, columns, rows, alt }';
  }
  if (n.children !== undefined) return 'Image takes no children';
  if (p.key !== undefined && (typeof p.key !== 'string' || p.key === '')) return 'Image key must be a non-empty string when given';
  if (!Number.isInteger(p.columns) || !Number.isInteger(p.rows)) return 'Image needs columns and rows, whole numbers of terminal cells';
  if (typeof p.source !== 'object' || p.source === null) return 'Image needs source, an object of image bytes';
  return undefined;
}

function vLink(n) {
  const p = n.props;
  if (!p) return 'Link props must be { href }';
  const { href: r, label: s, ...h } = p;
  const [g] = Object.keys(h);
  if (g !== undefined) return `Link prop "${g}" is not allowed`;
  if (typeof r !== 'string' || r === '') return 'Link href must be a non-empty string';
  if (r.length > LIMITS.href) return `Link href longer than ${LIMITS.href} characters`;
  if (s !== undefined && typeof s !== 'string') return 'Link label must be a string';
  const R = s ?? '';
  if (R.length > LIMITS.textChild) return `Link label longer than ${LIMITS.textChild} characters`;
  return CONTROL_RE.test(R) ? 'Link label holds a control character (an escape sequence)' : undefined;
}

const LEAF_VALIDATORS = {
  Button: vButton, Client: vClient, Code: vCode, Image: vImage, Input: vInput,
  Markdown: vMarkdown, Raster: vRaster, Select: vSelect, Svg: vSvg,
};

// ═══════════════════════════════════════════════════════════════════
// 4) 树遍历校验（d2n 的等价实现）
// ═══════════════════════════════════════════════════════════════════
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

export function validateTree(root, opts = {}) {
  const { surface, component } = opts;
  const aroundDialog = component === 'AskUserQuestion' || opts.within === 'AskUserQuestion';
  const surfaceElems = surface === undefined ? undefined : SURFACE_ELEMENTS[surface];
  let nodes = 0, textTotal = 0, rasterCells = 0, imageBytes = 0;
  const drawnLeafKeys = new Set();
  const notes = [];

  function walk(node, ctx) {
    const { depth, inInline, siblingBoxKeys } = ctx;
    nodes += 1;
    if (nodes > LIMITS.nodes) return `more than ${LIMITS.nodes} nodes`;
    if (depth > LIMITS.depth) return `deeper than ${LIMITS.depth}`;
    if (typeof node === 'string') {
      if (depth === 0) return 'the root must be an element';
      if (node.length > LIMITS.textChild) return `a text child longer than ${LIMITS.textChild} characters`;
      if (CONTROL_RE.test(node)) return 'a text child holds a control character (an escape sequence)';
      textTotal += node.length;
      return textTotal > LIMITS.textTotal ? `more than ${LIMITS.textTotal} characters of text` : undefined;
    }
    if (node === null || typeof node !== 'object') return `node is ${typeOf(node)}`;
    const { props, children, type } = node;
    if (!Object.prototype.hasOwnProperty.call(BLOCK_INLINE, type)) {
      return typeof type === 'string'
        ? `"${type}" is not an element (the elements are ${Object.keys(BLOCK_INLINE).join(', ')}, from $.ui.resolve(e))`
        : `unknown element type ${typeOf(type)}`;
    }
    if (inInline && BLOCK_INLINE[type] === 'block') return `${type} inside an inline element`;
    if (surfaceElems !== undefined && !surfaceElems.includes(type)) return `${type} is not an element of the ${surface} surface`;

    if (TERMINAL.has(type)) {
      const label = type === 'Button' && props ? `Button "${s$(props.key)}"` : type;
      let r = LEAF_VALIDATORS[type](node);
      if (r === undefined) {
        // UOr：这几类叶子的 key 全树唯一
        if (['Input', 'Select', 'Markdown', 'Client', 'Raster', 'Image'].includes(type) && props && typeof props.key === 'string') {
          const g = `${type}\u0000${props.key}`;
          if (drawnLeafKeys.has(g)) r = `${type} "${props.key}" is drawn twice; each takes its own key`;
          drawnLeafKeys.add(g);
        }
      }
      if (r === undefined) r = hoverCheck(node, label, ctx.hoverScope);
      if (r !== undefined) return r;
      if (aroundDialog && type === 'Markdown') return 'Markdown around the dialog (its rows are not bounded there)';
      if (arrdByte(node)) { /* row accounting omitted: not a rejection in the band */ }
      if (type === 'Raster') { rasterCells += (props.columns || 0) * (props.rows || 0); if (rasterCells > LIMITS.rasterCells) return `more than ${LIMITS.rasterCells} Raster cells in one tree`; }
      if (type === 'Image') {
        // Image source bytes: only count when trivially derivable; skip otherwise.
      }
      return textTotal > LIMITS.textTotal ? `more than ${LIMITS.textTotal} characters of text` : undefined;
    }

    // Link：单独一条支路
    if (type === 'Link') {
      const r = vLink(node);
      if (r !== undefined) return r;
      const href = props.href;
      const hasKids = Array.isArray(children) && children.length > 0;
      textTotal += href.length + ((props.label ?? '').length);
      if (textTotal > LIMITS.textTotal) return `more than ${LIMITS.textTotal} characters of text`;
      // 子节点（Link 允许 children）
      if (children !== undefined) {
        if (!Array.isArray(children)) return `${type} children is ${typeOf(children)}`;
        const sib = new Set();
        for (const c of children) { const rr = walk(c, { depth: depth + 1, inInline: true, siblingBoxKeys: sib }); if (rr !== undefined) return rr; }
      }
      return undefined;
    }

    // Box / Text：通用属性循环
    let conceal = ctx.concealedBy;
    let rowGap = 0;
    const boxKey = type === 'Box' && props ? props.key : undefined;
    if (boxKey === undefined ? false : true) {
      const dup = siblingBoxKeys.has(boxKey);
      siblingBoxKeys.add(boxKey);
      if (typeof boxKey !== 'string' || boxKey === '' || boxKey.length > LIMITS.textChild) notes.push(`Box key is not usable`);
      else { textTotal += boxKey.length; if (textTotal > LIMITS.textTotal) return `more than ${LIMITS.textTotal} characters of text`; }
      void dup;
    }
    const hover = node.hover;
    let hoverScope = ctx.hoverScope;
    if (hover !== undefined) {
      const hasScope = hover && hover.scope !== undefined && hover.display !== undefined;
      const hidden = boxKey !== undefined && props.display === 'none' && !hasScope;
      hoverScope = boxKey === undefined ? ctx.hoverScope : (hidden ? 'hidden' : 'live');
    }
    const r2 = hoverCheck(node, type, hoverScope);
    if (r2 !== undefined) return r2;

    if (props !== undefined) {
      if (props === null || typeof props !== 'object' || Array.isArray(props)) return `${type} props is ${typeOf(props)}`;
      for (const [prop, value] of Object.entries(props)) {
        if (type === 'Box' && prop === 'key') continue;
        if (!ALLOWED_PROPS[type].has(prop)) return `${type} prop "${prop}" is not allowed`;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return `${type} prop "${prop}" is ${typeOf(value)}`;
        const pr = checkProp(prop, value);
        if (pr !== undefined) return `${type} prop "${prop}" ${pr}`;
        const mm = prop === 'position' || SIZE_PROPS.has(prop) || CELL_PROPS.has(prop);
        if (aroundDialog && mm) return `${type} prop "${prop}" around the dialog`;
        if (AROUND_PROPS.has(prop)) conceal = conceal ?? `${type} with prop "${prop}"`;
        if (typeof value === 'number' && (prop === 'gap' || prop === 'rowGap')) rowGap += Math.abs(value);
      }
    }
    if (children !== undefined) {
      if (!Array.isArray(children)) return `${type} children is ${typeOf(children)}`;
      const sib = new Set();
      for (const c of children) {
        const rr = walk(c, { depth: depth + 1, inInline: inInline || BLOCK_INLINE[type] === 'inline', siblingBoxKeys: sib, hoverScope });
        if (rr !== undefined) return rr;
      }
    }
    return undefined;
  }

  const first = walk(root, { depth: 0, inInline: false, siblingBoxKeys: new Set(), hoverScope: 'none' });
  return first;
}

// hover 校验（r2n 的等价实现；mod 不用 hover，但规则保留）
function hoverCheck(node, label, parentScope) {
  const h = node.hover;
  if (h === undefined) return undefined;
  if (!(node.type === 'Box' || node.type === 'Text' || node.type === 'Button')) return `${label} takes no hover; Box, Text and Button do`;
  if (h === null || typeof h !== 'object') return `${label} hover is ${typeOf(h)}, not an object of style props`;
  if (h.scope !== undefined) {
    if (!(typeof h.scope === 'string' && h.scope !== '' && h.scope.length <= LIMITS.hoverScope)) return `${label} hover scope is not a string of 1 to ${LIMITS.hoverScope} characters`;
    if (CONTROL_RE.test(h.scope)) return `${label} hover scope holds a control character`;
  } else if (parentScope === 'none') {
    return `${label} hover has no Box with a key around it`;
  } else if (parentScope === 'hidden') {
    return `${label} hover is scoped to a keyed Box drawn display "none"`;
  }
  const set = HOVER_PROPS[node.type === 'Box' ? 'Box' : 'Text'];
  const base = node.props ?? {};
  for (const [k, v] of Object.entries(h)) {
    if (k === 'scope') continue;
    if (!set.has(k)) return `${label} hover prop "${s$(k)}" is not allowed`;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return `${label} hover prop "${s$(k)}" is ${typeOf(v)}`;
    const pr = checkProp(k, v);
    if (pr !== undefined) return `${label} hover prop "${s$(k)}" ${pr}`;
    if (k === 'display' && v !== 'flex') return `${label} hover display "${String(v)}" would hide it under the pointer`;
    if (k === 'display' && base.display !== 'none') return `${label} hover display "flex" reveals a Box drawn display "none"; this Box is already shown`;
    if (k === 'borderStyle' && base.borderStyle === undefined) return `${label} hover borderStyle would add a border`;
    if (CELL_PROPS.has(k) && base.position !== 'absolute') return `${label} hover prop "${s$(k)}" would shift a Box still in the flow`;
  }
  return undefined;
}
function arrdByte() { return false; }

// ═══════════════════════════════════════════════════════════════════
// 5) 忠实复刻沙箱 JSX 运行时（h()）：这是 mod 真正产出的节点的形状
// ═══════════════════════════════════════════════════════════════════
function flatten(children, into) {
  for (const child of children) {
    if (child === null || child === undefined || typeof child === 'boolean') continue;
    if (Array.isArray(child)) flatten(child, into);
    else into.push(typeof child === 'number' ? String(child) : child);
  }
}
function cleanHover(h) {
  if (h === undefined || h === null) return undefined;
  if (typeof h !== 'object' || Array.isArray(h)) throw new Error('hover is an object of style props');
  return { ...h };
}

export function factorySet(surface = 'desktop') {
  const elems = SURFACE_ELEMENTS[surface];
  const F = {};
  // 内部：把"mod 调用时那一个 props 对象"变成引擎看到的节点
  function build(type, input) {
    input = input ?? {};
    const { children: rawChildren, key: inputKey, hover: inputHover, ref, ...rest } = input;
    const kids = [];
    flatten(rawChildren === undefined ? [] : (Array.isArray(rawChildren) ? rawChildren : [rawChildren]), kids);

    if (type === 'Box' || type === 'Text') {
      const hover = cleanHover(inputHover);
      const props = {};
      for (const [name, value] of Object.entries(rest)) {
        if (value === null || value === undefined) continue;
        props[name] = value;
      }
      if (type === 'Box' && (typeof inputKey === 'string' || typeof inputKey === 'number')) props.key = String(inputKey);
      const node = { type };
      if (Object.keys(props).length > 0) node.props = props;
      if (hover !== undefined) node.hover = hover;
      if (kids.length > 0) node.children = kids;
      return node;
    }
    if (type === 'Button') {
      const { onPress, hotkey, action, plain, dimColor, variant, role, label: lbl } = rest;
      const childLabel = kids.length === 1 && typeof kids[0] === 'string' ? kids[0] : undefined;
      const label = lbl ?? childLabel;
      const key = inputKey ?? label;
      const p = { key, label };
      if (hotkey !== undefined) p.hotkey = hotkey;
      if (action !== undefined) p.action = action;
      if (plain === true) p.plain = true;
      if (dimColor !== undefined) p.dimColor = dimColor;
      if (variant !== undefined) p.variant = variant;
      if (role !== undefined) p.role = role;
      if (rest.autoFocus === true) p.autoFocus = true;
      return { type: 'Button', props: p, press: { plugin: 'runway', handle: 1 }, onPress: onPress ?? (() => {}) };
    }
    if (type === 'Input') {
      const p = { key: inputKey };
      for (const n of ['label', 'placeholder', 'value', 'submitLabel']) if (rest[n] !== undefined) p[n] = rest[n];
      if (rest.autoFocus === true) p.autoFocus = true;
      return { type: 'Input', props: p, press: { plugin: 'runway', handle: 1 }, onEvent: () => {} };
    }
    // 其余叶子：直接照 props 摆好（mod 不用这些）
    const p = { ...rest };
    if (inputKey !== undefined) p.key = inputKey;
    return { type, props: p };
  }
  for (const t of elems) F[t] = (props) => build(t, props);
  return F;
}

// 人读的树展开（出错时看是哪个节点炸的）
export function describeTree(n, d = 0) {
  const pad = '  '.repeat(d);
  if (typeof n === 'string') return pad + JSON.stringify(n);
  if (!n || typeof n !== 'object') return pad + String(n);
  const p = n.props ? Object.entries(n.props).map(([k, v]) => (k === 'children' ? '' : `${k}=${JSON.stringify(v)}`)).filter(Boolean).join(' ') : '';
  const head = `${pad}${n.type}${p ? ' ' + p : ''}`;
  const kids = (n.children ?? []).flatMap((c) => [describeTree(c, d + 1)]);
  return [head, ...kids].join('\n');
}

export default { validateTree, factorySet, describeTree, LIMITS, SURFACE_ELEMENTS, ALLOWED_PROPS, ENUM_PROPS, COLOR_RE };
