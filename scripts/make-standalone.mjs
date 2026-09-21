// 生成网页独立版： node scripts/make-standalone.mjs
//
// 源（唯一真源）: frontend/dist/index.html   ← 桌面应用内嵌的前端
// 产物（派生）  : index/bingotools-V17.html           ← 单文件、可脱离桌面应用独立打开
//
// 派生规则：
//   1. 摘掉 hls.min.js / flv.min.js 两个外部脚本引用，保证「单文件」自洽；
//   2. 默认切到「模式一：B站播放器」（源文件默认是模式二，而模式二独立版不可用）；
//   3. 注入「独立版锁定层」：需要桌面应用后端或外部 html 的功能锁死，
//      鼠标悬停提示「请使用桌面应用」。
//
// 可独立使用：B站播放器（模式一，纯 iframe 嵌入）、本地采集、裁切、记分、
//             计时、骰子、备忘、美化、字体。
// 锁定：抖音采集（模式二，需 Go 后端取流）、Bingo Maker（外部 html），
//       以及「确认使用」在抖音来源/模式二下的取流动作。
//
// 注意：产物是派生的，不要直接改 index/bingotools-V17.html；改完源文件后重新运行本脚本。

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(root, 'frontend/dist/index.html');
const OUT = resolve(root, 'index/bingotools-V17.html');

// 恒锁定：功能在任何情况下都需要外部依赖
const STATIC_LOCKED = [
  'goBingoMaker()',        // 依赖外部文件 bingomaker.html
  'setLiveCaptureMode(2)', // 抖音采集：单文件内没有 Go 后端可取流
];

// 条件锁定：由注入脚本在每次交互时实时求值（见下方 RULES）
const DYNAMIC_LOCKED = [
  'confirmLiveId()',       // 抖音来源 / 模式二时需后端取流；B站 + 模式一走 iframe，放行
];

// 明确保留可用（纯浏览器能力，无需桌面后端）
const KEPT_ONCLICK = [
  'setLiveCaptureMode(1)',                             // B站播放器（iframe 嵌入）
  'showLiveModal(1)', 'showLiveModal(2)',              // 直播设置弹窗（含导入导出）
  'captureLocalScreenFromModal()',                     // getDisplayMedia
  'openLiveCropFromSet(1)', 'openLiveCropFromSet(2)',  // 裁切（嵌入画面/本地采集可用）
  'refreshLive(1)', 'refreshLive(2)',                  // 模式一刷新走 iframe，无需后端
];

const LOCK_STYLE = `
/* ================= 网页独立版锁定层（由 scripts/make-standalone.mjs 注入） ================= */
.standalone-locked {
  cursor: not-allowed !important;
  filter: grayscale(0.7);
  opacity: 0.5 !important;
}
.standalone-locked:hover { opacity: 0.62 !important; }
#standaloneLockTip {
  position: fixed;
  z-index: 99999;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(20, 20, 22, 0.97);
  border: 1px solid #fb8c00;
  color: #ffcc80;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease;
  font-family: 'Microsoft YaHei', Arial, sans-serif;
}
#standaloneLockTip.is-visible { opacity: 1; }
.standalone-notice {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(251, 140, 0, 0.12);
  border: 1px solid rgba(251, 140, 0, 0.5);
  color: #ffcc80;
  font-size: 12px;
  line-height: 1.5;
}
`;

// 注入脚本刻意使用字符串拼接，避免与外层模板字符串冲突
const LOCK_SCRIPT = `
<script>
/* ============ 网页独立版锁定层（由 scripts/make-standalone.mjs 注入） ============ */
(function () {
  'use strict';
  var TIP_TEXT = '请使用桌面应用';
  var STATIC_LOCKED = ${JSON.stringify(STATIC_LOCKED)};
  var DYNAMIC_LOCKED = ${JSON.stringify(DYNAMIC_LOCKED)};

  // ---------- 独立版默认使用模式一（B站播放器） ----------
  // 源文件默认 liveCaptureMode = 2（抖音采集），而模式二在单文件里没有后端可取流，
  // 停在默认值会让 B站 反而用不了，因此显式切到模式一。
  try { if (typeof setLiveCaptureMode === 'function') setLiveCaptureMode(1); } catch (e) {}

  // ---------- 判定：此功能此刻是否真的需要桌面应用 ----------
  function captureModeNow() {
    try { return typeof getLiveCaptureMode === 'function' ? getLiveCaptureMode() : 1; }
    catch (e) { return 1; }
  }
  function sourceTypeNow() {
    var input = document.getElementById('liveIdInput');
    if (!input || typeof parseLiveSource !== 'function') return '';
    try {
      var s = parseLiveSource(String(input.value || '').trim());
      return s ? s.type : '';
    } catch (e) { return ''; }
  }
  // 模式二恒需后端；抖音来源也需后端。B站 + 模式一 = iframe 嵌入，放行。
  function confirmNeedsBackend() {
    return captureModeNow() === 2 || sourceTypeNow() === 'douyin';
  }

  // need() 返回 true 表示需要桌面应用 -> 锁定
  var RULES = [
    { onclick: 'goBingoMaker()', need: function () { return true; } },
    { onclick: 'setLiveCaptureMode(2)', need: function () { return true; } },
    { onclick: 'confirmLiveId()', need: confirmNeedsBackend }
  ];

  // ---------- 悬停提示 ----------
  var tip = document.createElement('div');
  tip.id = 'standaloneLockTip';
  tip.textContent = TIP_TEXT;
  document.body.appendChild(tip);

  function showTip(el) {
    tip.classList.add('is-visible');
    var r = el.getBoundingClientRect();
    var top = r.top - tip.offsetHeight - 8;
    if (top < 4) top = r.bottom + 8;
    var left = r.left + (r.width - tip.offsetWidth) / 2;
    if (left < 4) left = 4;
    var maxLeft = window.innerWidth - tip.offsetWidth - 4;
    if (left > maxLeft) left = maxLeft;
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }
  function hideTip() { tip.classList.remove('is-visible'); }

  // ---------- 规则匹配与状态刷新 ----------
  function ruleFor(el) {
    var code = (el.getAttribute('onclick') || '').replace(/\\s+/g, '');
    for (var i = 0; i < RULES.length; i++) if (RULES[i].onclick === code) return RULES[i];
    return null;
  }

  function applyLock(el, locked) {
    el.classList.toggle('standalone-locked', locked);
    if (locked) {
      el.setAttribute('aria-disabled', 'true');
      el.removeAttribute('title');
    } else {
      el.removeAttribute('aria-disabled');
    }
  }

  function refreshLocks() {
    var all = document.querySelectorAll('[onclick]');
    for (var i = 0; i < all.length; i++) {
      var rule = ruleFor(all[i]);
      if (!rule) continue;
      var locked;
      try { locked = !!rule.need(); } catch (e) { locked = true; }
      applyLock(all[i], locked);
    }
  }

  // 绑定锁定元素：悬停时先按最新状态刷新，再决定是否弹提示
  var governed = [];
  (function bind() {
    var all = document.querySelectorAll('[onclick]');
    for (var i = 0; i < all.length; i++) {
      (function (el) {
        if (!ruleFor(el) || el.dataset.standaloneBound === '1') return;
        el.dataset.standaloneBound = '1';
        governed.push(el);
        el.addEventListener('mouseenter', function () {
          refreshLocks();
          if (el.classList.contains('standalone-locked')) showTip(el); else hideTip();
        });
        el.addEventListener('mousemove', function () {
          if (el.classList.contains('standalone-locked')) showTip(el);
        });
        el.addEventListener('mouseleave', hideTip);
        el.addEventListener('focus', function () {
          refreshLocks();
          if (el.classList.contains('standalone-locked')) showTip(el); else hideTip();
        });
        el.addEventListener('blur', hideTip);
      })(all[i]);
    }
  })();

  // 状态变化后刷新：模式切换、输入框内容变化、弹窗打开
  var input = document.getElementById('liveIdInput');
  if (input) {
    input.addEventListener('input', refreshLocks);
    input.addEventListener('change', refreshLocks);
  }
  ['setLiveCaptureMode', 'showLiveModal'].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      var r = orig.apply(this, arguments);
      refreshLocks();
      return r;
    };
  });

  // ---------- 拦截：鼠标点击 ----------
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[onclick]') : null;
    if (!el) return;
    var rule = ruleFor(el);
    if (!rule) return;
    var locked;
    try { locked = !!rule.need(); } catch (err) { locked = true; }
    if (!locked) return; // 实时求值：此刻不需要后端就放行
    applyLock(el, true);
    e.preventDefault();
    e.stopPropagation();
    showTip(el);
  }, true);

  // ---------- 拦截：键盘 Enter / Space ----------
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target && e.target.closest ? e.target.closest('[onclick]') : null;
    if (!el) return;
    var rule = ruleFor(el);
    if (!rule) return;
    var locked;
    try { locked = !!rule.need(); } catch (err) { locked = true; }
    if (!locked) return;
    e.preventDefault();
    e.stopPropagation();
    showTip(el);
  }, true);

  // ---------- 直播设置弹窗内补一条说明 ----------
  var modal = document.querySelector('#liveModal .modal');
  if (modal) {
    var notice = document.createElement('p');
    notice.className = 'standalone-notice';
    notice.textContent = '网页独立版已默认切到「模式一：B站播放器」，可用 B站直播、本地采集、裁切、'
      + '记分、计时、骰子、备忘等功能。抖音采集（模式二）与 Bingo Maker 需要桌面应用，相关按钮已锁定。';
    var btns = modal.querySelector('.modal-buttons');
    if (btns) modal.insertBefore(notice, btns); else modal.appendChild(notice);
  }

  refreshLocks();
})();
</script>
`;

function fail(msg) { console.error('生成失败: ' + msg); process.exit(1); }

let html = readFileSync(SRC, 'utf8');

// --- 1. 摘掉外部脚本引用 ---
for (const tag of ['<script src="hls.min.js"></script>', '<script src="flv.min.js"></script>']) {
  if (!html.includes(tag)) fail(`源文件中找不到 ${tag}（源文件结构可能已变）`);
  html = html.replace(tag, '');
}
if (/<script[^>]+src=|<link[^>]+href=/i.test(html)) fail('仍存在外部脚本/样式引用，无法保证单文件自洽');

// --- 2. 校验治理目标与保留目标都存在 ---
const onclickSet = new Set(
  [...html.matchAll(/onclick="([^"]+)"/g)].map((m) => m[1].replace(/\s+/g, ''))
);
for (const c of [...STATIC_LOCKED, ...DYNAMIC_LOCKED]) {
  if (!onclickSet.has(c)) fail(`找不到待治理按钮 onclick="${c}"`);
}
for (const c of KEPT_ONCLICK) if (!onclickSet.has(c)) fail(`找不到应保留按钮 onclick="${c}"`);

// --- 3. 注入锁定层 ---
// 样式必须注入到已有 <style> 内部，否则 </style> 之后的内容会变成页面文本且不生效
const styleEndCount = html.split('</style>').length - 1;
if (styleEndCount !== 1) fail(`期望恰好 1 个 </style>，实际 ${styleEndCount} 个`);
if (!html.includes('</body>')) fail('找不到 </body>');
html = html.replace('</style>', LOCK_STYLE + '</style>');
html = html.replace('</body>', LOCK_SCRIPT + '</body>');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, 'utf8');

// --- 4. 产物自检 ---
const out = readFileSync(OUT, 'utf8');
if (/<script[^>]+src=|<link[^>]+href=/i.test(out)) fail('产物仍含外部引用');
for (const marker of ["tip.id = 'standaloneLockTip'", 'standalone-locked', "var TIP_TEXT = '请使用桌面应用'", 'standalone-notice', 'function confirmNeedsBackend()']) {
  if (!out.includes(marker)) fail(`产物缺少标记: ${marker}`);
}
// 关键：锁定层 CSS 必须落在 <style>...</style> 内部，否则不会生效
const cssPos = out.indexOf('.standalone-locked {');
const styleOpen = out.indexOf('<style>');
const styleClose = out.indexOf('</style>');
if (!(styleOpen < cssPos && cssPos < styleClose)) fail('锁定层 CSS 未被注入到 <style> 内部');
// 锁定层脚本必须在 </style> 之后、</body> 之前（此时应用脚本已定义、DOM 已解析）
const lockJsPos = out.indexOf("tip.id = 'standaloneLockTip'");
if (!(out.lastIndexOf('<script>', lockJsPos) > styleClose && lockJsPos < out.indexOf('</body>'))) {
  fail('锁定层脚本注入位置不正确');
}

const kb = (statSync(OUT).size / 1024).toFixed(1);
console.log('已生成 index/bingotools-V17.html  (' + kb + ' KB)');
console.log('  恒锁定: ' + STATIC_LOCKED.join(', '));
console.log('  条件锁定: ' + DYNAMIC_LOCKED.join(', ') + '  (抖音来源或模式二时)');
console.log('  保留可用: B站播放器(模式一) / 本地采集 / 裁切 / 直播设置弹窗 / 刷新');
console.log('  独立版默认采集模式: 模式一：B站播放器');
console.log('  已移除外部引用: hls.min.js, flv.min.js');
