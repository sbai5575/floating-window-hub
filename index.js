// ============================================================================
// 悬浮窗管理中心 (Floating Window Hub)
// ----------------------------------------------------------------------------
// 作用: 把页面上杂乱的多余悬浮窗脚本统一收进"一个"悬浮球里管理。
//   - 自身提供一个可拖拽、可吸附边缘的悬浮球，作为唯一入口
//   - 点击悬浮球打开管理中心面板，统合开关/显示/隐藏所有已注册的悬浮窗
//   - 支持自动扫描页面中的悬浮窗、手动添加、开关状态持久化
//   - PC 与移动端自适应，动画流畅(仅 transform/opacity)
// ============================================================================

// 完全自包含：不 import 任何酒馆模块，状态用 localStorage 持久化，
// 因此无论装到酒馆哪个目录都能正常加载，避免相对路径导致的"装了不能用"。

const EXT_NAME = '悬浮窗管理中心';
const LS_KEY = 'fwh_state_v1';
// 每次修改默认行为/存储结构时递增，用于识别旧 localStorage 残留并做兼容修正
const VERSION = '1.14.0';

// ---------------------------------------------------------------------------
// 默认设置
// ---------------------------------------------------------------------------
const DEFAULTS = {
  bubble: {
    // (x, y) 为悬浮球左上角像素坐标；null 表示尚未定位，将在运行时用视口右下角默认位置
    x: null,
    y: null,
    hidden: false,
  },
  // 已注册悬浮窗列表
  windows: [],
  // 管理中心面板(可移动/可缩放)几何信息
  panel: {
    x: 0, y: 0,       // 手动定位后的左上角(px)
    w: 480, h: 640,   // 自定义宽高(px)
    positioned: false, // 是否已手动移动/缩放(未移动则用默认右下布局)
  },
  options: {
    snapEdges: true,     // 拖拽后自动吸附左右边缘
    bubbleAutoHide: false, // 打开面板后自动收起悬浮球(减少遮挡)
    keepPosition: true,  // 记住每个悬浮窗的展开/收起状态
    layoutMode: 'list',  // 收纳列表排列模式：list=纵向列表 / grid=网格卡片
  },
};

// 图标候选池
const ICONS = ['🪟', '🧰', '⚙️', '🔧', '📦', '🎛️', '🗂️', '💬', '🛠️', '✨', '🎨', '📜', '🧮', '🔍', '🧿', '📚'];

// 自动扫描时使用的关键词(匹配 id/class)，遇到以下特征视为"悬浮窗"候选
// 覆盖：原生 DOM / jQuery / Vue / React / 外链脚本 常见命名
const KEYWORDS = /float|dock|hub|panel|widget|bubble|overlay|menushift|popup|quick|assistant|helper|toolbar|fab|drawer|trainer|cheat|hack|pkmn|pokemon|pok[eé]mon|workshop|phone|forum|status|hud|boss|host|btn|win|bar/i;

// 隐藏第三方悬浮窗时注入的类名
const HIDE_CLASS = 'fwh-hide-target';       // 彻底关闭(display:none)
const GHOST_CLASS = 'fwh-hide-ghost';       // 隐形(visibility:hidden, 脚本仍运行)

// 保存被覆盖前的内联样式，用于恢复显示时精确还原(避免破坏原脚本自身的内联 pointer-events/display 等)
const inlinePreserved = new WeakMap();

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------
let settings;
let panelEl, bubbleEl, listEl, listMetaEl;
let rootNodes = []; // buildDOM 追加到 body 的根节点，用于被 SPA 清空后自动重新挂载
let isPanelOpen = false;
let panelOpenedAt = 0; // 面板最近一次打开的时刻，用于拦截同一手势派生的冗余关闭
// 记录被"进入/呼出"的第三方悬浮窗的原样式，便于隐藏/还原时恢复
const winOverrides = new Map();
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
// 与 style.css 的移动端断点保持一致：窄屏或触摸(粗指针)设备按移动端处理。
// 用 innerWidth 兜底，避免个别旧浏览器对 (hover)/(pointer) 媒体特性支持不全。
const isMobileView = () => {
  if (window.innerWidth <= 640) return true;
  try {
    return !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  } catch (e) {
    return false;
  }
};

// ---------------------------------------------------------------------------
// 设置读写
// ---------------------------------------------------------------------------
function loadSettings() {
  settings = Object.assign({}, DEFAULTS);
  let src = null;
  try {
    src = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  } catch (e) {
    src = null;
  }
  if (src) {
    settings.windows = Array.isArray(src.windows) ? src.windows : [];
    settings.bubble = Object.assign({}, DEFAULTS.bubble, src.bubble || {});
    settings.panel = Object.assign({}, DEFAULTS.panel, src.panel || {});
    settings.options = Object.assign({}, DEFAULTS.options, src.options || {});
    // 版本门控：旧版 localStorage 可能残留 bubble.hidden=true(用户以前点过「隐藏悬浮球」)，
    // 手机端又没有可用的双击恢复入口，导致重新导入后悬浮球凭空消失、无法使用。
    // 存储版本不一致时强制恢复悬浮球显示。
    if (src.v !== VERSION) {
      settings.bubble.hidden = false;
      settings.bubble.x = null;
      settings.bubble.y = null;
    }
  }
}

function saveSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({ v: VERSION }, settings)));
  } catch (e) {
    /* 忽略 storage 异常(隐私模式等) */
  }
}

// 简单工具
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') node.className = attrs[k];
    else if (k === 'html') node.innerHTML = attrs[k];
    else if (k === 'style') node.setAttribute('style', attrs[k]);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c) node.append(c);
  });
  return node;
};

// ---------------------------------------------------------------------------
// 悬浮窗目标切换(显示/隐藏/隐形)
// ---------------------------------------------------------------------------
// 判断元素当前是否已处于目标隐藏态(读内联样式，避免重复 getComputedStyle)。
function hideStillValid(t, state) {
  if (state === 'closed') return t.style.display === 'none';
  return t.style.visibility === 'hidden';
}

// 把第三方悬浮窗真正隐藏(关闭=display:none；隐形=不可见但脚本仍运行)。
// 同时禁用动画/过渡，避免原脚本的脉动/闪烁动画覆盖隐藏态。
// 幂等：已是目标态时直接跳过，避免无谓重写再次触发 MutationObserver。
function applyHideStyles(t, state) {
  if (hiddenLock.get(t) === state && hideStillValid(t, state)) return;
  const cls = state === 'closed' ? HIDE_CLASS : GHOST_CLASS;
  const other = state === 'closed' ? GHOST_CLASS : HIDE_CLASS;
  if (t.classList.contains(other)) t.classList.remove(other);
  if (!t.classList.contains(cls)) t.classList.add(cls);
  if (state === 'closed') {
    t.style.setProperty('display', 'none', 'important');
    t.style.setProperty('visibility', 'hidden', 'important');
  } else {
    t.style.setProperty('visibility', 'hidden', 'important');
  }
  t.style.setProperty('opacity', '0', 'important');
  t.style.setProperty('pointer-events', 'none', 'important');
  t.style.setProperty('animation', 'none', 'important');
  t.style.setProperty('transition', 'none', 'important');
}

function applyWindowState(win, silent) {
  const targets = resolveTargets(win.selector);
  if (targets.length === 0) {
    const was = win.missing;
    win.missing = true;
    if (!was && !silent) console.warn(`[悬浮窗收纳] 未匹配到元素：${win.selector}`);
    return false;
  }
  win.missing = false;
  const state = getWinState(win);
  targets.forEach((t) => {
    // 首次覆盖时记录原始内联样式，便于恢复
    if (!inlinePreserved.has(t)) {
      inlinePreserved.set(t, {
        display: t.style.display,
        visibility: t.style.visibility,
        opacity: t.style.opacity,
        pointerEvents: t.style.pointerEvents,
        animation: t.style.animation,
        transition: t.style.transition,
      });
    }
    if (state === 'closed' || state === 'hidden') {
      hiddenLock.set(t, state);
      applyHideStyles(t, state);
    } else {
      // open：精确还原原始内联样式，只移除我们加的内联覆盖
      hiddenLock.delete(t);
      t.classList.remove(HIDE_CLASS, GHOST_CLASS);
      const o = inlinePreserved.get(t) || { display: '', visibility: '', opacity: '', pointerEvents: '', animation: '', transition: '' };
      t.style.display = o.display;
      t.style.visibility = o.visibility;
      t.style.opacity = o.opacity;
      t.style.pointerEvents = o.pointerEvents;
      t.style.animation = o.animation;
      t.style.transition = o.transition;
      inlinePreserved.delete(t);
    }
  });
  initHideGuard();
  return true;
}

// ---------------------------------------------------------------------------
// 隐藏守护：部分脚本(如宝可梦论坛 ces)会周期性用 inline !important 重新 show 自己的
// 悬浮球，导致收纳后图标"一闪一闪"。这里监听已隐藏元素的 style/class 被外部改写，
// 立即(同一微任务、尚未绘制前)补回隐藏态，从视觉上彻底消除闪烁。
// ---------------------------------------------------------------------------
const hiddenLock = new WeakMap(); // element -> 'hidden' | 'closed'
let hideGuardObserver = null;
let hideGuardApplying = false;

function initHideGuard() {
  if (hideGuardObserver || typeof MutationObserver === 'undefined') return;
  hideGuardObserver = new MutationObserver((records) => {
    if (hideGuardApplying) return;
    const targets = new Set();
    for (const r of records) {
      const t = r.target;
      if (t && t.nodeType === 1 && hiddenLock.has(t)) targets.add(t);
    }
    if (!targets.size) return;
    hideGuardApplying = true;
    try {
      targets.forEach((t) => {
        if (!t.isConnected) { hiddenLock.delete(t); return; }
        applyHideStyles(t, hiddenLock.get(t));
      });
    } finally {
      hideGuardApplying = false;
    }
  });
  // 观察 style/class 属性变化；只处理在 hiddenLock 中的元素，其它变化开销极小
  hideGuardObserver.observe(document.documentElement, {
    subtree: true,
    childList: false,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
}

// 深查：document.querySelectorAll 无法穿透 Shadow DOM，很多酒馆脚本(如宝可梦创意工坊)
// 把悬浮球 #fab 放在 open shadow root 内部。这里递归进入 shadow root 查询，保证
// 收纳悬浮窗的"进入"能点到阴影里的真实触发按钮。
function deepQueryAll(selector, root) {
  const base = root || document;
  const out = [];
  const seen = new Set();
  const collect = (r) => {
    let found;
    try { found = r.querySelectorAll(selector); } catch (e) { found = []; }
    found.forEach((n) => {
      if (!seen.has(n)) { seen.add(n); out.push(n); }
    });
  };
  const walk = (r) => {
    collect(r);
    let hosts;
    try { hosts = r.querySelectorAll('*'); } catch (e) { hosts = []; }
    hosts.forEach((h) => {
      if (h.shadowRoot) walk(h.shadowRoot);
    });
  };
  walk(base);
  return out;
}

// 深度遍历某个元素及其 shadow DOM 内所有后代(用于扫描按钮/图标/触发入口)
function deepWalk(root, visit) {
  if (!root) return;
  visit(root);
  const next = [];
  if (root.children) for (const c of root.children) next.push(c);
  if (root.shadowRoot && root.shadowRoot.children) for (const c of root.shadowRoot.children) next.push(c);
  next.forEach((c) => deepWalk(c, visit));
}

function getTargets(selector) {
  try {
    return deepQueryAll(selector).filter(
      (t) => !t.classList || !t.classList.contains('fwh-root'),
    );
  } catch (e) {
    return [];
  }
}

// 目标元素缓存：避免酒馆界面高频刷新时重复 querySelectorAll 重新计算。
// 只要元素仍在文档中(isConnected)就直接复用引用，只有元素被重建/移除时才重查。
const targetCache = new Map(); // selector -> Element[]

function resolveTargets(selector) {
  const cached = targetCache.get(selector);
  if (cached && cached.length && cached.every((e) => e.isConnected)) {
    return cached;
  }
  const els = getTargets(selector);
  if (els.length) targetCache.set(selector, els);
  else targetCache.delete(selector);
  return els;
}

function invalidateCache(selector) {
  if (selector) targetCache.delete(selector);
  else targetCache.clear();
}

// ---------------------------------------------------------------------------
// 自动守护：监听 DOM 变化，对被收纳(隐藏/关闭)的悬浮窗自动补回状态。
// 应对 Vue/React 的 v-if 重建、异步 import 延迟渲染等导致元素被替换的场景。
// ---------------------------------------------------------------------------
let guardObserver = null;
let guardTimer = null;

function guardAllWindows() {
  let changed = false;
  for (const w of settings.windows) {
    const state = getWinState(w);
    if (state !== 'hidden' && state !== 'closed') continue;
    const before = w.missing;
    applyWindowState(w, true);
    if (before !== w.missing) changed = true;
  }
  if (changed) renderList();
}

function setupGuard() {
  if (guardObserver || typeof MutationObserver === 'undefined') return;
  guardObserver = new MutationObserver(() => {
    if (guardTimer) return;
    guardTimer = setTimeout(() => {
      guardTimer = null;
      guardAllWindows();
    }, 250);
  });
  guardObserver.observe(document.body, { childList: true, subtree: true, attributes: false });
}

// ── 三态模型：open(显示可互动) / hidden(隐藏·脚本运行·不可见不可互动) / closed(彻底关闭) ──
function getWinState(win) {
  return win.state || (win.enabled === false ? 'closed' : 'open');
}

// 设置状态并持久化
function setWinState(win, state) {
  win.state = state;
  win.enabled = state === 'open'; // 向后兼容旧字段
  applyWindowState(win);
  if (state !== 'open') restoreOverrides(win); // 非打开状态不占前台
  saveSettings();
  renderList();
}

// 打开 / 关闭 一键切换（打开＝可见可互动；关闭＝彻底从画面移除）
function toggleWindow(win) {
  setWinState(win, getWinState(win) === 'open' ? 'closed' : 'open');
}

// 隐藏：保持该悬浮窗自身脚本运行，但外部看不到也点不到
function hideWindow(win) {
  setWinState(win, getWinState(win) === 'hidden' ? 'open' : 'hidden');
}

// 构造 pointer 事件：优先真正的 PointerEvent 并用 MouseEvent 兜底。
// 很多外链脚本(如状态栏/修仙面板)在宿主 window 上监听 pointerdown/pointerup，
// PointerEvent 能提供 pointerId/pointerType 等字段，兼容性更好。
function makePointerEvent(type, base) {
  if (typeof PointerEvent === 'function') {
    return new PointerEvent(type, {
      ...base,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      buttons: type === 'pointerdown' ? 1 : 0,
    });
  }
  return new MouseEvent(type, base);
}

// 派发一套完整点击序列，兼容 React/Vue 绑定在 onClick / onMouseDown / onPointerDown 上的监听器
function fireClickSequence(target, base) {
  target.dispatchEvent(makePointerEvent('pointerdown', base));
  target.dispatchEvent(new MouseEvent('mousedown', base));
  target.dispatchEvent(makePointerEvent('pointerup', base));
  target.dispatchEvent(new MouseEvent('mouseup', base));
  target.dispatchEvent(new MouseEvent('click', base));
}

// 进入：触发原悬浮窗的展开动作，直接显示它点开后弹出的内容面板(而非悬浮球本身)
function enterWindow(win) {
  const trigger = resolveTargets(win.triggerSelector || win.selector)[0] || resolveTargets(win.selector)[0];
  if (!trigger) { shortToast(`未找到「${win.name}」的触发入口`); return; }
  // 若彻底关闭则转入隐藏(脚本运行·不可见)，保证可被程序化触发
  if (getWinState(win) === 'closed') setWinState(win, 'hidden');

  const rect = trigger.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
  try {
    // 派发完整点击序列，让原脚本自己的 click / pointerdown 监听器展开内容面板
    fireClickSequence(trigger, base);
    shortToast(`已展开「${win.name}」的内容面板，请在页面中查看`);
  } catch (err) {
    if (typeof trigger.click === 'function') {
      trigger.click();
      shortToast(`已展开「${win.name}」的内容面板`);
    }
  }
}

function avoidOverlap(win, t) {
  const style = getComputedStyle(t);
  if (style.position !== 'fixed' || !panelEl || !panelEl.classList.contains('open')) return;
  const rp = panelEl.getBoundingClientRect();
  const rt = t.getBoundingClientRect();
  const overlap = !(rt.right <= rp.left || rt.left >= rp.right || rt.bottom <= rp.top || rt.top >= rp.bottom);
  if (!overlap) return;
  const ov = winOverrides.get(win.id) || {};
  if (!('left' in ov)) { ov.left = t.style.left; ov.top = t.style.top; }
  winOverrides.set(win.id, ov);
  // 放到面板右侧(空间不足则左侧)，靠近但互不重叠
  const w = rt.width;
  let nx = rp.right + 12;
  if (nx + w > window.innerWidth - 4) nx = Math.max(4, rp.left - w - 12);
  let ny = clamp(rp.top, 4, Math.max(4, window.innerHeight - rt.height - 4));
  t.style.left = nx + 'px';
  t.style.top = ny + 'px';
}

function restoreOverrides(win) {
  const ov = winOverrides.get(win.id);
  if (!ov) return;
  const t = getTargets(win.selector)[0];
  if (t) {
    t.style.zIndex = ov.z || '';
    if ('left' in ov) { t.style.left = ov.left || ''; t.style.top = ov.top || ''; }
  }
  winOverrides.delete(win.id);
}

// ---------------------------------------------------------------------------
// 代理模式：扫描悬浮窗内的可交互元素，用本面板的按钮代替点击
// ---------------------------------------------------------------------------
function scanWindowActions(win) {
  const t = resolveTargets(win.selector)[0];
  const out = [];
  if (!t) return out;
  const seen = new Set();
  const clickable = 'button, a, input[type="button"], input[type="submit"], [role="button"], [onclick]';
  // 深扫描(含 shadow DOM)，覆盖宝可梦创意工坊这类把按钮放在阴影里的脚本
  deepWalk(t, (n) => {
    if (n === t) return;
    if (!n.matches || !n.matches(clickable)) return;
    if (seen.has(n)) return;
    seen.add(n);
    if (n.closest && n.closest('.fwh-root')) return; // 跳过本插件自身
    const raw = ((n.innerText || n.textContent || '') + ' ' + (n.value || '')).trim();
    const label = raw.replace(/\s+/g, ' ').trim().slice(0, 14)
      || n.getAttribute('aria-label') || n.title || '';
    if (!label) return;
    if (out.some((o) => o.label === label)) return; // 同名去重，避免刷屏
    out.push({ label, el: n });
  });
  return out.slice(0, 12);
}

function makeProxyChip(win, label, ref) {
  const b = el('button', {
    class: 'fwh-proxy-chip',
    type: 'button',
    title: `触发「${win.name}」中的「${label}」`,
  }, [label]);
  b.addEventListener('click', (ev) => { ev.stopPropagation(); clickProxy(win, ref); });
  return b;
}

function clickProxy(win, ref) {
  // 收纳态(隐藏)才是代理模式的目标：不可见但脚本运行、可被程序化触发
  if (getWinState(win) === 'closed') setWinState(win, 'hidden');
  const el2 = typeof ref === 'string' ? getTargets(ref)[0] : ref;
  if (!el2) { shortToast('未找到目标按钮'); return; }
  if (el2.closest && el2.closest('.fwh-root')) { shortToast('不能触发本插件自身'); return; }

  const label = ((el2.innerText || el2.textContent || '') + ' ' + (el2.value || '')).trim().slice(0, 14) || '操作';
  const rect = el2.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };

  try {
    // 完整鼠标事件序列：兼容 React/Vue 绑定在 onMouseDown / onPointerDown 的组件
    el2.dispatchEvent(makePointerEvent('pointerdown', base));
    el2.dispatchEvent(new MouseEvent('mousedown', base));
    el2.dispatchEvent(makePointerEvent('pointerup', base));
    el2.dispatchEvent(new MouseEvent('mouseup', base));
    // 原生可点击控件用 .click() 触发默认行为(如 checkbox/button)，否则派发 click 事件
    if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)$/.test(el2.tagName)) {
      el2.click();
    } else {
      el2.dispatchEvent(new MouseEvent('click', base));
    }
    shortToast(`已触发「${win.name} · ${label}」`);
  } catch (err) {
    if (typeof el2.click === 'function') {
      el2.click();
      shortToast(`已触发「${win.name} · ${label}」`);
    }
  }
}

// ---------------------------------------------------------------------------
// 自动扫描页面中可能的悬浮窗
// ---------------------------------------------------------------------------
function scanCandidates() {
  // 同时扫描 body 后代与 <html> 直接子元素（部分脚本把悬浮窗挂在 documentElement 上，如 Shadow DOM 宿主）
  const all = document.querySelectorAll('body *, html > *');
  const found = [];
  const seen = new Set();

  for (const node of all) {
    if (node.classList.contains('fwh-root')) continue;
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'LINK') continue;
    const id = node.id || '';
    const cls = node.className && typeof node.className === 'string' ? node.className : '';
    if (!KEYWORDS.test(id) && !KEYWORDS.test(cls)) continue;
    const style = window.getComputedStyle(node);
    // 已收纳元素(带本插件隐藏类)即使被隐藏/尺寸归零也参与扫描，保证重新扫描不丢失
    const isOurs = node.classList.contains(GHOST_CLASS) || node.classList.contains(HIDE_CLASS);
    if (!isOurs && (style.visibility === 'hidden' || style.display === 'none')) continue;
    if (style.position !== 'fixed' && style.position !== 'absolute') continue;
    if (!isOurs && (node.offsetWidth < 24 || node.offsetHeight < 24)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    // 若存在更大且几何大小相同的祖先容器，则跳过当前节点，只保留最外层容器
    let skip = false;
    let parent = node.parentElement;
    while (parent && parent !== document.documentElement) {
      const pCls = parent.className && typeof parent.className === 'string' ? parent.className : '';
      const pId = parent.id || '';
      if ((parent.offsetWidth === node.offsetWidth) && (parent.offsetHeight === node.offsetHeight)) {
        if (KEYWORDS.test(pCls) || KEYWORDS.test(pId)) { skip = true; break; }
      }
      parent = parent.parentElement;
    }
    if (!skip) found.push(node);
  }

  // 去重 + 限制数量
  const uniq = [];
  const dedupe = new Set();
  for (let n of found) {
    // Shadow DOM 宿主：改为收纳阴影内真正的小悬浮球，避免把内容面板一起藏掉(否则"进入"打不开面板)
    const host = n.shadowRoot ? n : null;
    const ball = host ? findFloatTrigger(host) : null;
    const nameSrc = host || n;      // 名字沿用宿主(更可读)
    const iconSrc = ball || n;      // 图标取悬浮球内部信号
    if (ball) n = ball;
    const sel = buildSelector(n);
    if (dedupe.has(sel)) continue;
    dedupe.add(sel);
    uniq.push({ node: n, selector: sel, name: inferName(nameSrc), icon: inferIcon(iconSrc), triggerSelector: inferTriggerSelector(n) });
  }
  return uniq.slice(0, 12);
}

// 生成一个尽量稳定的选择器
function buildSelector(node) {
  if (node.id) {
    // 转义以确保安全
    const safe = CSS.escape(node.id);
    return `#${safe}`;
  }
  for (const cls of node.classList) {
    // 跳过易变的动态类
    if (/^(js-|v-|_|\d|active|open|show|hidden)/i.test(cls)) continue;
    return `${node.tagName.toLowerCase()}.${CSS.escape(cls)}`;
  }
  return node.tagName.toLowerCase();
}

function inferName(node) {
  const label =
    node.dataset && (node.dataset.title || node.dataset.name || node.dataset.label) ||
    node.getAttribute('aria-label') ||
    node.title ||
    '';
  if (label) return label.trim().slice(0, 12);
  return (node.id || (node.classList[0] || node.tagName)).replace(/[_-]+/g, ' ').trim() || '悬浮窗';
}

// 从原悬浮窗元素里提取「头像/图标」：优先内部 <img>，其次背景图，最后回退到首字符
function inferIcon(node) {
  const img = node.querySelector && node.querySelector('img');
  if (img && img.src && /^(https?:|data:|blob:)/.test(img.src)) return img.src;
  if (node.tagName === 'IMG' && node.src && /^(https?:|data:|blob:)/.test(node.src)) return node.src;
  const txt = (node.innerText || node.textContent || '').trim();
  if (txt) {
    const m = txt.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{2BFF}]/u);
    if (m) return m[0];
    return txt.slice(0, 1);
  }
  const bi = window.getComputedStyle(node).backgroundImage || '';
  const url = bi.match(/url\(["']?([^"')]+)["']?\)/);
  if (url) return url[1];
  return null; // 无图标信号，由调用方用默认 emoji
}

// 在 Shadow DOM 宿主里定位"悬浮球"(小尺寸、fixed/absolute、可点击、高 z-index)。
// 宝可梦创意工坊这类脚本把悬浮球 #fab 和内容面板都塞进同一个全屏宿主里，
// 若收纳整个宿主会把面板也一并藏掉，导致"进入"打不开面板。此时应只藏悬浮球。
function findFloatTrigger(node) {
  if (!node.shadowRoot) return null;
  const clickable = 'button, a, [role="button"], [onclick], input[type="button"], input[type="submit"]';
  let best = null, bestScore = -Infinity;
  deepWalk(node, (n) => {
    if (n === node) return;
    if (!n.matches || !n.matches(clickable)) return;
    const cs = window.getComputedStyle(n);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = n.getBoundingClientRect();
    if (r.width < 20 || r.height < 20 || r.width > 220 || r.height > 220) return;
    let z = parseInt(cs.zIndex, 10);
    if (!Number.isFinite(z)) z = 0;
    const score = z * 10 + r.width * r.height;
    if (score > bestScore) { bestScore = score; best = n; }
  });
  return best;
}

// 为 Shadow DOM 宿主类悬浮窗自动推断"进入"用的触发按钮(如阴影里的 #fab)。
// 仅当宿主含 open shadowRoot 时才推断：此时点击宿主本身无效，必须点阴影里的悬浮球。
function inferTriggerSelector(node) {
  const ball = findFloatTrigger(node);
  return ball ? buildSelector(ball) : '';
}

// 根据 icon 值生成图标元素：图片 URL 渲染 <img>，否则渲染 emoji/文本
function iconEl(icon, fallback) {
  const v = icon || fallback || '🪟';
  if (typeof v === 'string' && /^(https?:|data:|blob:)/.test(v)) {
    const im = el('img', { class: 'fwh-icon-img', alt: '' });
    im.src = v;
    im.addEventListener('error', () => { im.remove(); });
    return im;
  }
  return (typeof v === 'string' ? v : fallback || '🪟');
}

// ---------------------------------------------------------------------------
// 渲染悬浮窗列表
// ---------------------------------------------------------------------------
// 应用收纳列表排列模式：list=纵向列表 / grid=网格卡片
function applyLayoutMode() {
  if (!listEl) return;
  const mode = settings.options.layoutMode;
  listEl.classList.toggle('grid', mode === 'grid');
}

function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';
  applyLayoutMode();

  let anyEnabled = false;
  const items = settings.windows.map((win) => {
    applyWindowState(win);
    if (win.enabled) anyEnabled = true;
    return win;
  });

  // 计数徽标
  listMetaEl && (listMetaEl.textContent = `${settings.windows.length} 个`);

  if (items.length === 0) {
    listEl.append(
      el('div', { class: 'fwh-empty' }, [
        el('div', { class: 'fwh-empty-ic' }, ['🪟']),
        el('div', { class: 'fwh-empty-t' }, ['还没有注册任何悬浮窗']),
        el('div', { class: 'fwh-empty-s' }, ['点下方「扫描」自动识别页面的悬浮窗，或「添加」手动登记。']),
      ]),
    );
    syncPanelStatus(anyEnabled);
    return;
  }

  items.forEach((win) => {
    const state = getWinState(win);
    const rowCls = ['fwh-row'];
    if (state === 'open') rowCls.push('is-on');
    if (state === 'hidden') rowCls.push('is-ghost');
    if (win.missing) rowCls.push('is-missing');
    const row = el('div', { class: rowCls.join(' '), title: `点击进入「${win.name}」悬浮窗` });
    const rowMain = el('div', { class: 'fwh-row-main' });

    const ic = el('div', { class: 'fwh-row-ic' }, [iconEl(win.icon, '🪟')]);
    ic.setAttribute('title', '点击进入该悬浮窗');
    const nameEl = el('div', { class: 'fwh-row-name' }, [win.name]);
    const info = el('div', { class: 'fwh-row-body' }, [
      nameEl,
      el('div', { class: 'fwh-row-sel' }, [win.selector]),
    ]);

    const statusTxt = win.missing ? '?' : state === 'hidden' ? '隐' : state === 'open' ? '开' : '关';
    const status = el('div', {
      class: 'fwh-row-status ' + (state === 'hidden' ? 'ghost' : state === 'open' ? 'on' : ''),
      title: win.missing ? '未在页面上找到该元素' : state === 'hidden' ? '已隐藏(脚本运行中)' : state === 'open' ? '已显示' : '已关闭',
    }, [statusTxt]);

    // 行主区域点击 = "进入"该悬浮窗(置顶、避开面板、收起本面板便于查看)
    rowMain.addEventListener('click', () => enterWindow(win));

    // ── 动作：打开(开关) / 隐藏 / 命名 / 编辑 / 移除 ──
    // 行主区域点击已承担「进入」，无需单独进入按钮
    const openBtn = el('button', {
      class: 'fwh-row-btn ' + (state === 'open' ? 'is-on' : ''),
      title: state === 'open' ? '关闭(彻底移除)' : '打开(显示)',
    }, [state === 'open' ? '◉' : '◯']);
    openBtn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleWindow(win); });

    const hideBtn = el('button', {
      class: 'fwh-row-btn hide ' + (state === 'hidden' ? 'is-on' : ''),
      title: '隐藏(脚本继续运行·外面看不到也点不到)',
    }, ['🙈']);
    hideBtn.addEventListener('click', (ev) => { ev.stopPropagation(); hideWindow(win); });

    const renameBtn = el('button', { class: 'fwh-row-btn', title: '重命名' }, ['✏']);
    renameBtn.addEventListener('click', (ev) => { ev.stopPropagation(); startRename(win, nameEl); });

    const edit = el('button', { class: 'fwh-row-btn', title: '编辑' }, ['✎']);
    edit.addEventListener('click', (ev) => { ev.stopPropagation(); openEditDialog(win); });
    const del = el('button', { class: 'fwh-row-btn danger', title: '移除' }, ['🗑']);
    del.addEventListener('click', (ev) => { ev.stopPropagation(); removeWindow(win); });

    const actions = el('div', { class: 'fwh-row-actions' }, [openBtn, hideBtn, renameBtn, edit, del]);
    rowMain.append(ic, info, status, actions);
    row.append(rowMain);

    // ── 代理按钮：代替已隐藏悬浮窗触发其内部按钮(如"打卡") ──
    const proxies = scanWindowActions(win);
    const manual = (win.actions || []).filter((a) => a && a.label && a.selector);
    if (proxies.length || manual.length) {
      const chips = [];
      proxies.forEach((p) => chips.push(makeProxyChip(win, p.label, p.el)));
      manual.forEach((a) => chips.push(makeProxyChip(win, a.label, a.selector)));
      row.append(el('div', { class: 'fwh-proxy-bar' }, [
        el('div', { class: 'fwh-proxy-hint' }, ['⚡ 替代操作']),
        ...chips,
      ]));
    }

    listEl.append(row);
  });

  syncPanelStatus(anyEnabled);
}

function syncPanelStatus(anyEnabled) {
  if (!bubbleEl) return;
  bubbleEl.classList.toggle('has-active', anyEnabled);
  const badge = bubbleEl.querySelector('.fwh-bubble-badge');
  const count = settings.windows.filter((w) => getWinState(w) !== 'closed').length;
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  }
}

// ---------------------------------------------------------------------------
// 添加 / 移除 / 编辑
// ---------------------------------------------------------------------------
// 行内重命名：把名称区替换为输入框，回车/失焦提交，Esc 取消
function startRename(win, nameEl) {
  const input = el('input', { class: 'fwh-rename-input', type: 'text', value: win.name, maxlength: 20 });
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v) { win.name = v; saveSettings(); }
    renderList();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') renderList();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', commit);
  // replaceChildren 较新(Chrome 86+)，旧安卓/iOS WebView 可能不支持，用兼容写法
  nameEl.innerHTML = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
}

function addWindow(data, silent) {
  const win = {
    id: 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: data.name || '新悬浮窗',
    selector: data.selector,
    triggerSelector: data.triggerSelector || '',
    icon: data.icon || ICONS[Math.floor(Math.random() * ICONS.length)],
    enabled: false,
    state: 'hidden', // 收纳即隐藏：加入后立即藏起原悬浮窗
    actions: [],
    custom: !!data.custom,
  };
  // 选择器去重
  settings.windows = settings.windows.filter((w) => w.selector !== win.selector);
  settings.windows.push(win);
  saveSettings();
  applyWindowState(win, true); // 立即应用隐藏
  renderList();
  if (!silent) shortToast(`已收纳「${win.name}」，原悬浮窗已隐藏`);
}

function removeWindow(win) {
  // 移除前先清除隐藏类，让原悬浮窗恢复显示
  try {
    const targets = resolveTargets(win.selector);
    targets.forEach((t) => t.classList.remove(HIDE_CLASS, GHOST_CLASS));
  } catch (e) {}
  invalidateCache(win.selector);
  window.dispatchEvent(new CustomEvent('fwh-toast', { detail: `已移除「${win.name}」，原悬浮窗已恢复显示` }));
  settings.windows = settings.windows.filter((w) => w.id !== win.id);
  saveSettings();
  renderList();
}

function openEditDialog(win, isNew = false) {
  const wrap = document.getElementById('fwh-dialog-wrap');
  const nameIn = wrap.querySelector('.di-name');
  const selIn = wrap.querySelector('.di-sel');
  const trigIn = wrap.querySelector('.di-trigger');
  const iconIn = wrap.querySelector('.di-icon');
  const actsIn = wrap.querySelector('.di-acts');
  const title = wrap.querySelector('.di-title');
  title.textContent = isNew ? '添加悬浮窗' : '编辑悬浮窗';
  nameIn.value = win.name;
  selIn.value = win.selector;
  trigIn.value = win.triggerSelector || '';
  iconIn.value = win.icon || '🪟';
  actsIn.value = (win.actions || []).map((a) => `${a.label}|${a.selector}`).join('\n');
  wrap.dataset.editingId = win.id || '';
  wrap.classList.add('open');
  setTimeout(() => iconIn.focus(), 50);
}

function closeEditDialog() {
  const wrap = document.getElementById('fwh-dialog-wrap');
  wrap.classList.remove('open');
}

function commitEditDialog() {
  const wrap = document.getElementById('fwh-dialog-wrap');
  const nameIn = wrap.querySelector('.di-name');
  const selIn = wrap.querySelector('.di-sel');
  const trigIn = wrap.querySelector('.di-trigger');
  const iconIn = wrap.querySelector('.di-icon');
  const actsIn = wrap.querySelector('.di-acts');
  const name = nameIn.value.trim();
  const selector = selIn.value.trim();
  const triggerSelector = trigIn.value.trim();
  const icon = iconIn.value.trim() || '🪟';
  if (!selector) { shortToast('请输入元素选择器'); return; }

  // 校验选择器是否有效
  let valid = true;
  try { document.querySelector(selector); } catch (e) { valid = false; }
  if (!valid) { shortToast('选择器无效，请检查'); return; }

  // 解析替代操作：每行「按钮名|css选择器」
  const actions = (actsIn.value || '').split('\n').map((ln) => {
    const i = ln.indexOf('|');
    if (i < 0) return null;
    const label = ln.slice(0, i).trim();
    const sel = ln.slice(i + 1).trim();
    return (label && sel) ? { label, selector: sel } : null;
  }).filter(Boolean);

  const editingId = wrap.dataset.editingId;
  if (editingId) {
    const win = settings.windows.find((w) => w.id === editingId);
    if (win) { win.name = name; win.selector = selector; win.triggerSelector = triggerSelector; win.icon = icon; win.actions = actions; }
  } else {
    addWindow({ name, selector, triggerSelector, icon, custom: true });
    const last = settings.windows[settings.windows.length - 1];
    if (last) last.actions = actions;
  }
  saveSettings();
  renderList();
  closeEditDialog();
}

// ---------------------------------------------------------------------------
// 悬浮球拖拽 + 边缘吸附
// ---------------------------------------------------------------------------
function applyBubbleStyle() {
  if (!bubbleEl) return;
  const size = bubbleEl.offsetWidth || 56;
  let x = settings.bubble.x;
  let y = settings.bubble.y;
  // 未定位(旧数据/null)时用右下角默认位置，避免悬浮球落到屏幕最上方
  if (typeof x !== 'number' || !isFinite(x)) x = window.innerWidth - size - 16;
  if (typeof y !== 'number' || !isFinite(y)) y = window.innerHeight - size - 90;
  settings.bubble.x = clamp(x, 0, Math.max(0, window.innerWidth - size));
  settings.bubble.y = clamp(y, 0, Math.max(0, window.innerHeight - size));
  bubbleEl.style.left = settings.bubble.x + 'px';
  bubbleEl.style.top = settings.bubble.y + 'px';
  bubbleEl.style.transform = 'none';
  bubbleEl.classList.toggle('is-hidden', !!settings.bubble.hidden);
  if (settings.bubble.hidden) bubbleEl.classList.add('fwh-bubble-min');
}

// ── 面板：应用保存的几何(位置/大小) ──────────────────────────────
function applyPanelGeometry() {
  if (!panelEl) return;
  const p = settings.panel;
  // 移动端始终走底部抽屉的响应式布局，忽略 PC 端可能保存的坏坐标
  // (x/y=0 或旧数据会把面板钉死在屏幕最上方)。
  if (p.positioned && !isMobileView()) {
    // PC 端：钳制尺寸避免超出可视区
    const maxW = Math.max(280, window.innerWidth - 16);
    const maxH = Math.max(300, window.innerHeight - 40);
    const w = Math.min(p.w, maxW);
    const h = Math.min(p.h, maxH);
    panelEl.style.left = p.x + 'px';
    panelEl.style.top = p.y + 'px';
    panelEl.style.right = '';
    panelEl.style.bottom = '';
    panelEl.style.width = w + 'px';
    panelEl.style.height = h + 'px';
    panelEl.style.maxHeight = 'none';
  } else {
    panelEl.style.left = '';
    panelEl.style.top = '';
    panelEl.style.right = '';
    panelEl.style.bottom = '';
    panelEl.style.width = '';
    panelEl.style.height = '';
    panelEl.style.maxHeight = '';
  }
  // PC 端保持原有的 top left 原点(拖动/缩放后动画不偏移)；移动端清空以让 CSS 的 bottom center 生效
  panelEl.style.transformOrigin = isMobileView() ? '' : 'top left';
}

// ── 面板：拖动头部移动 ──────────────────────────────────────────
function setupPanelDrag() {
  const head = panelEl.querySelector('.fwh-panel-head');
  const hasPointer = typeof PointerEvent === 'function';
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
  let pointerId = null;

  const readPos = (e) => (e.touches && e.touches.length ? e.touches[0] : e);

  const down = (e) => {
    if (e.target.closest('.fwh-close')) return; // 不拦截关闭按钮
    e.preventDefault();
    e.stopPropagation();
    dragging = true; moved = false;
    pointerId = e.pointerId != null ? e.pointerId : null;
    const p = readPos(e);
    const r = panelEl.getBoundingClientRect();
    sx = p.clientX; sy = p.clientY;
    ox = p.clientX - r.left; oy = p.clientY - r.top;
    // 锁定当前尺寸并清除 right/bottom，使移动端也能脱离底部抽屉自由拖动
    if (!panelEl.style.width) panelEl.style.width = r.width + 'px';
    if (!panelEl.style.height) panelEl.style.height = r.height + 'px';
    settings.panel.w = r.width;
    settings.panel.h = r.height;
    panelEl.style.right = '';
    panelEl.style.bottom = '';
    panelEl.style.maxHeight = 'none';
    if (pointerId != null) { try { head.setPointerCapture(pointerId); } catch (e) {} }
    head.classList.add('dragging');
  };
  const move = (e) => {
    if (!dragging) return;
    if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
    const p = readPos(e);
    const dx = p.clientX - sx, dy = p.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 4) moved = true;
    if (!moved) return;
    const r = panelEl.getBoundingClientRect();
    settings.panel.positioned = true;
    const x = clamp(p.clientX - ox, 8 - r.width + 60, window.innerWidth - 60);
    const y = clamp(p.clientY - oy, 8, window.innerHeight - 80);
    settings.panel.x = x; settings.panel.y = y;
    panelEl.style.left = x + 'px';
    panelEl.style.top = y + 'px';
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false; moved = false;
    if (pointerId != null) { try { head.releasePointerCapture(pointerId); } catch (e) {} }
    head.classList.remove('dragging');
    if (settings.panel.positioned) saveSettings();
  };

  head.addEventListener('pointerdown', down);
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', up);
  head.addEventListener('pointercancel', up);

  // 仅旧设备(无 PointerEvent)才用 touch 回退；现代安卓 Chrome/Edge 会同时派发 pointer 与 touch，
  // 二者都绑定会重复触发 down/up(点击面板闪烁后消失、无法拖动)
  if (!hasPointer) {
    head.addEventListener('touchstart', down, { passive: true });
    head.addEventListener('touchmove', move, { passive: true });
    head.addEventListener('touchend', up);
    head.addEventListener('touchcancel', up);
  }
}

// ── 面板：右下角缩放 ────────────────────────────────────────────
function setupResize() {
  const handle = panelEl.querySelector('.fwh-resize');
  if (!handle) return;
  const hasPointer = typeof PointerEvent === 'function';
  let dragging = false, sx = 0, sy = 0, sw = 0, sh = 0;
  let pointerId = null;

  const readPos = (e) => (e.touches && e.touches.length ? e.touches[0] : e);

  const down = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    pointerId = e.pointerId != null ? e.pointerId : null;
    const p = readPos(e);
    sx = p.clientX; sy = p.clientY;
    sw = panelEl.offsetWidth; sh = panelEl.offsetHeight;
    const r = panelEl.getBoundingClientRect();
    settings.panel.x = r.left;
    settings.panel.y = r.top;
    settings.panel.positioned = true;
    if (pointerId != null) { try { handle.setPointerCapture(pointerId); } catch (e) {} }
    handle.classList.add('resizing');
  };
  const move = (e) => {
    if (!dragging) return;
    if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
    const p = readPos(e);
    const w = clamp(sw + (p.clientX - sx), 300, window.innerWidth - 8);
    const h = clamp(sh + (p.clientY - sy), 320, window.innerHeight - 56);
    settings.panel.w = w; settings.panel.h = h;
    panelEl.style.width = w + 'px';
    panelEl.style.height = h + 'px';
    panelEl.style.maxHeight = 'none';
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('resizing');
    if (pointerId != null) { try { handle.releasePointerCapture(pointerId); } catch (e) {} }
    saveSettings();
  };

  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  if (!hasPointer) {
    handle.addEventListener('touchstart', down, { passive: true });
    handle.addEventListener('touchmove', move, { passive: true });
    handle.addEventListener('touchend', up);
    handle.addEventListener('touchcancel', up);
  }
}

function setupDrag() {
  const hasPointer = typeof PointerEvent === 'function';
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
  let pointerId = null;
  let lastTapAt = 0; // 已由 pointer/touch 处理的轻触时间，避免 click 二次触发

  // 统一取坐标：PointerEvent 直接取，TouchEvent 取首个触点(旧安卓/iOS 无 PointerEvent)
  const readPos = (e) => (e.touches && e.touches.length ? e.touches[0] : e);

  const onStart = (e) => {
    // 安卓默认手势(滚动/缩放)会抢走触摸导致拖不动；参考泉此方：pointerdown 必须
    // preventDefault + stopPropagation，否则浏览器触发 pointercancel 中断拖拽。
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    moved = false;
    pointerId = e.pointerId != null ? e.pointerId : null;
    const p = readPos(e);
    const rect = bubbleEl.getBoundingClientRect();
    sx = p.clientX; sy = p.clientY;
    ox = p.clientX - rect.left;
    oy = p.clientY - rect.top;
    bubbleEl.classList.add('dragging');
    if (pointerId != null) { try { bubbleEl.setPointerCapture(pointerId); } catch (e) {} }
  };

  const onMove = (e) => {
    if (!dragging) return;
    if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
    const p = readPos(e);
    const dx = p.clientX - sx, dy = p.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 6) moved = true;
    if (!moved) return;
    const size = bubbleEl.offsetWidth || 56;
    const x = clamp(p.clientX - ox, 0, window.innerWidth - size);
    const y = clamp(p.clientY - oy, 0, window.innerHeight - size);
    settings.bubble.x = x;
    settings.bubble.y = y;
    bubbleEl.style.left = x + 'px';
    bubbleEl.style.top = y + 'px';
    bubbleEl.style.transform = 'none';
  };

  const onEnd = (e) => {
    if (!dragging) return;
    dragging = false;
    bubbleEl.classList.remove('dragging');
    if (pointerId != null) { try { bubbleEl.releasePointerCapture(pointerId); } catch (e) {} }
    if (e && e.pointerId != null && pointerId != null && e.pointerId !== pointerId) return;
    // 边缘吸附：水平吸到左右边缘，纵向保持用户拖到的位置
    if (settings.options.snapEdges && moved) {
      const size = bubbleEl.offsetWidth || 56;
      const x = (typeof settings.bubble.x === 'number' && isFinite(settings.bubble.x)) ? settings.bubble.x : 0;
      settings.bubble.x = (x + size / 2 < window.innerWidth / 2) ? 4 : window.innerWidth - size - 4;
      bubbleEl.style.left = settings.bubble.x + 'px';
    }
    saveSettings();
    // 轻触未拖动 → 直接切换面板(移动端 WebView 常不派发 click，这里兜底)
    if (!moved) {
      lastTapAt = Date.now();
      togglePanel();
    }
  };

  bubbleEl.addEventListener('pointerdown', onStart);
  bubbleEl.addEventListener('pointermove', onMove);
  bubbleEl.addEventListener('pointerup', onEnd);
  bubbleEl.addEventListener('pointercancel', onEnd);

  // 仅旧设备(无 PointerEvent)才用 touch 回退；现代安卓 Chrome/Edge 同时派发 pointer 与 touch，
  // 双重绑定会让 onEnd 触发两次 togglePanel(点击后界面闪烁又消失)且拖动状态被反复重置
  if (!hasPointer) {
    bubbleEl.addEventListener('touchstart', onStart, { passive: true });
    bubbleEl.addEventListener('touchmove', onMove, { passive: true });
    bubbleEl.addEventListener('touchend', onEnd);
    bubbleEl.addEventListener('touchcancel', onEnd);
  }

  // 桌面/部分浏览器的 click 兜底(若已被 pointer/touch 处理则忽略，避免重复开关)
  bubbleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moved) return;                        // 拖拽后不触发
    if (Date.now() - lastTapAt < 800) return; // 已被 pointer/touch 处理过
    lastTapAt = Date.now();                   // 自守卫：移动端 click 可能重复派发，防止 open↔close 连闪
    togglePanel();
  });

  // 右键：快捷菜单(全部开/全部关/隐藏悬浮球)
  bubbleEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openQuickMenu(e.clientX, e.clientY);
  });
}

// 快捷上下文菜单
function openQuickMenu(x, y) {
  const menu = document.getElementById('fwh-quickmenu');
  menu.style.left = `${Math.min(x, window.innerWidth - 170)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 140)}px`;
  menu.classList.add('open');
}

// ---------------------------------------------------------------------------
// 面板开关 + 动画
// ---------------------------------------------------------------------------
function togglePanel() {
  isPanelOpen ? closePanel() : openPanel();
}

function openPanel() {
  if (isPanelOpen) return;
  isPanelOpen = true;
  panelOpenedAt = Date.now();
  applyPanelGeometry(); // 恢复用户保存的位置/大小
  refreshMeta();
  renderList();
  document.getElementById('fwh-overlay').classList.add('show');
  panelEl.classList.remove('closed');
  panelEl.classList.add('open');
  // 面板不要盖住悬浮球：PC 端默认(未移动)则抬到气泡上方；移动端交给媒体查询的底部抽屉定位
  if (isMobileView() || settings.panel.positioned) {
    panelEl.style.bottom = '';
  } else if (bubbleEl) {
    panelEl.style.bottom = '92px';
    panelEl.style.top = '';
  }
  if (settings.options.bubbleAutoHide) {
    bubbleEl.classList.add('fwh-bubble-min');
  }
}

function closePanel() {
  if (!isPanelOpen) return;
  // 移动端同一手势可能派生多次合成 click/pointer 事件，导致「打开后立刻被关掉」的闪烁。
  // 打开后 350ms 内的关闭请求视为误触，直接忽略。
  if (Date.now() - panelOpenedAt < 350) return;
  isPanelOpen = false;
  document.getElementById('fwh-overlay').classList.remove('show');
  panelEl.classList.remove('open');
  panelEl.classList.add('closed');
  if (settings.options.bubbleAutoHide) {
    bubbleEl.classList.remove('fwh-bubble-min');
    applyBubbleStyle();
  }
}

function refreshMeta() {
  const count = settings.windows.length;
  const on = settings.windows.filter((w) => w.enabled).length;
  const elOn = document.getElementById('fwh-meta-on');
  elOn && (elOn.textContent = `${on}`);
}

function refreshOptionsUI() {
  const set = (id, v) => {
    const n = document.getElementById(id);
    if (n) n.checked = !!v;
  };
  set('opt-snap', settings.options.snapEdges);
  set('opt-autohide', settings.options.bubbleAutoHide);
  set('opt-keep', settings.options.keepPosition);
}

// ---------------------------------------------------------------------------
// 备份 / 还原
// ---------------------------------------------------------------------------
function exportSettings() {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `悬浮窗管理中心-备份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSettings(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (typeof data !== 'object' || !Array.isArray(data.windows)) {
        throw new Error('bad');
      }
      settings = {
        bubble: Object.assign({}, DEFAULTS.bubble, data.bubble || {}),
        windows: data.windows,
        options: Object.assign({}, DEFAULTS.options, data.options || {}),
      };
      saveSettings();
      applyBubbleStyle();
      refreshOptionsUI();
      renderList();
      shortToast('设置已还原');
    } catch (e) {
      shortToast('备份文件无效');
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Toast 提示
// ---------------------------------------------------------------------------
function shortToast(msg) {
  const t = el('div', { class: 'fwh-toast' }, [msg]);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 1400);
  setTimeout(() => t.remove(), 1900);
}

// ---------------------------------------------------------------------------
// 构建 DOM
// ---------------------------------------------------------------------------
function buildDOM() {
  // 遮罩
  const overlay = el('div', { class: 'fwh-overlay', id: 'fwh-overlay' });

  // 悬浮球
  bubbleEl = el('div', { class: 'fwh-root fwh-bubble', id: 'fwh-bubble' }, [
    el('div', { class: 'fwh-bubble-ic' }, ['🧭']),
    el('div', { class: 'fwh-bubble-badge' }, ['0']),
  ]);

  // 面板
  panelEl = el('div', { class: 'fwh-root fwh-panel closed', id: 'fwh-panel' });

  const header = el('div', { class: 'fwh-panel-head' }, [
    el('div', { class: 'fwh-logo' }, ['🧭']),
    el('div', { class: 'fwh-head-titles' }, [
      el('div', { class: 'fwh-title' }, [EXT_NAME]),
      el('div', { class: 'fwh-sub' }, [
        el('span', { class: 'fwh-dot' }),
        el('span', { id: 'fwh-meta-total', class: 'fwh-meta' }, [`${settings.windows.length} 个来源`]),
        el('span', { class: 'fwh-meta' }, ['· 已显示 ']),
        el('span', { id: 'fwh-meta-on', class: 'fwh-meta on' }, ['0']),
      ]),
    ]),
    el('button', { class: 'fwh-close', title: '收起' }, ['✕']),
  ]);

  const tabs = el('div', { class: 'fwh-tabs' }, [
    el('button', { class: 'fwh-tab active', 'data-tab': 'windows' }, ['悬浮窗']),
    el('button', { class: 'fwh-tab', 'data-tab': 'options' }, ['设置']),
  ]);

  // 悬浮窗列表页
  const tabWindows = el('div', { class: 'fwh-tabpage active', 'data-page': 'windows' }, [
    el('div', { class: 'fwh-actions-top' }, [
      el('button', { class: 'fwh-ghost fwh-btn-scan', id: 'btn-scan' }, ['🔍 扫描页面']),
      el('button', { class: 'fwh-ghost fwh-btn-addc', id: 'btn-addc' }, ['＋ 添加配置']),
    ]),
    el('div', { class: 'fwh-list', id: 'fwh-list' }),
    el('div', { class: 'fwh-foot-actions' }, [
      el('button', { class: 'fwh-mini', id: 'btn-all-on' }, ['全部显示']),
      el('button', { class: 'fwh-mini', id: 'btn-all-off' }, ['全部隐藏']),
    ]),
  ]);

  // 设置页
  const opt = settings.options;
  const tabOptions = el('div', { class: 'fwh-tabpage', 'data-page': 'options' }, [
    el('div', { class: 'fwh-opt-group' }, [
      el('div', { class: 'fwh-opt-item' }, [
        el('div', { class: 'fwh-opt-info' }, [
          el('div', { class: 'fwh-opt-name' }, ['拖拽后吸附边缘']),
          el('div', { class: 'fwh-opt-desc' }, ['PC 上拖拽悬浮球后，自动吸附到屏幕左右边缘']),
        ]),
        el('div', { class: 'fwh-switch ' + (opt.snapEdges ? 'on' : '') }, [el('div', { class: 'fwh-switch-knob' })]),
      ]),
      el('div', { class: 'fwh-opt-item' }, [
        el('div', { class: 'fwh-opt-info' }, [
          el('div', { class: 'fwh-opt-name' }, ['打开面板自动收起悬浮球']),
          el('div', { class: 'fwh-opt-desc' }, ['减少遮挡，面板关闭时自动恢复']),
        ]),
        el('div', { class: 'fwh-switch ' + (opt.bubbleAutoHide ? 'on' : '') }, [el('div', { class: 'fwh-switch-knob' })]),
      ]),
      el('div', { class: 'fwh-opt-item' }, [
        el('div', { class: 'fwh-opt-info' }, [
          el('div', { class: 'fwh-opt-name' }, ['记住展开/收起状态']),
          el('div', { class: 'fwh-opt-desc' }, ['重启酒馆后恢复每个悬浮窗的显示状态']),
        ]),
        el('div', { class: 'fwh-switch ' + (opt.keepPosition ? 'on' : '') }, [el('div', { class: 'fwh-switch-knob' })]),
      ]),
      el('div', { class: 'fwh-opt-item' }, [
        el('div', { class: 'fwh-opt-info' }, [
          el('div', { class: 'fwh-opt-name' }, ['收纳列表排列模式']),
          el('div', { class: 'fwh-opt-desc' }, ['列表：纵向单列；网格：紧凑卡片布局']),
        ]),
        el('div', { class: 'fwh-seg' }, [
          el('button', { class: 'fwh-seg-btn' + (opt.layoutMode === 'list' ? ' active' : ''), 'data-layout': 'list' }, ['▤ 列表']),
          el('button', { class: 'fwh-seg-btn' + (opt.layoutMode === 'grid' ? ' active' : ''), 'data-layout': 'grid' }, ['▦ 网格']),
        ]),
      ]),
    ]),
    el('div', { class: 'fwh-opt-group about' }, [
      el('div', { class: 'fwh-opt-about' }, [
        el('div', { class: 'fwh-about-title' }, ['关于']),
        el('div', { class: 'fwh-about-text' }, [`${EXT_NAME} 将页面上分散的悬浮窗脚本统一收纳进一个悬浮球，可按需显示/隐藏，桌面端与移动端均适配。`]),
      ]),
    ]),
    el('div', { class: 'fwh-opt-group' }, [
      el('div', { class: 'fwh-opt-row' }, [
        el('button', { class: 'fwh-mini flat', id: 'btn-scan-here' }, ['扫描悬浮窗']),
        el('button', { class: 'fwh-mini flat', id: 'btn-export' }, ['备份设置']),
        el('button', { class: 'fwh-mini flat', id: 'btn-import' }, ['还原设置']),
        el('input', { type: 'file', id: 'fwh-import-file', accept: 'application/json', style: 'display:none' }),
      ]),
    ]),
  ]);

  const body = el('div', { class: 'fwh-panel-body' }, [tabWindows, tabOptions]);
  const resizeHandle = el('div', { class: 'fwh-resize', title: '拖动调整大小' });
  panelEl.append(header, tabs, body, resizeHandle);

  // 扫描结果浮层
  const scanLayer = el('div', { class: 'fwh-scan', id: 'fwh-scan' }, [
    el('div', { class: 'fwh-scan-head' }, [
      el('div', {}, ['扫描结果']),
      el('button', { class: 'fwh-mini', id: 'scan-close' }, ['✕']),
    ]),
    el('div', { class: 'fwh-scan-list', id: 'fwh-scan-list' }),
  ]);

  // 编辑对话框
  const dialogWrap = el('div', { class: 'fwh-dialog-wrap', id: 'fwh-dialog-wrap' }, [
    el('div', { class: 'fwh-dialog' }, [
      el('div', { class: 'di-title' }, ['添加悬浮窗']),
      el('label', { class: 'di-label' }, ['名称']),
      el('input', { class: 'di-name', type: 'text', placeholder: '例如：管理器 / 面板' }),
      el('label', { class: 'di-label' }, ['选择器 (CSS)']),
      el('input', { class: 'di-sel', type: 'text', placeholder: '例如：#my-panel' }),
      el('label', { class: 'di-label' }, ['触发器选择器 (可选)']),
      el('input', { class: 'di-trigger', type: 'text', placeholder: '点击它来展开内容，留空=点上面选择器本身' }),
      el('label', { class: 'di-label' }, ['图标']),
      el('input', { class: 'di-icon', type: 'text', placeholder: '🪟' }),
      el('label', { class: 'di-label' }, ['替代操作(每行: 按钮名|css选择器)']),
      el('textarea', { class: 'di-acts', rows: 3, placeholder: '打卡|#checkin-btn\n刷新|.refresh' }),
      el('div', { class: 'di-actions' }, [
        el('button', { class: 'fwh-mini', id: 'di-cancel' }, ['取消']),
        el('button', { class: 'fwh-mini primary', id: 'di-ok' }, ['保存']),
      ]),
    ]),
  ]);

  // 快捷菜单
  const quickMenu = el('div', { class: 'fwh-quickmenu', id: 'fwh-quickmenu' }, [
    el('button', { class: 'qm-item', 'data-q': 'allon' }, ['👁 全部显示']),
    el('button', { class: 'qm-item', 'data-q': 'alloff' }, ['🙈 全部隐藏']),
    el('button', { class: 'qm-item', 'data-q': 'hide' }, ['📴 隐藏悬浮球']),
    el('button', { class: 'qm-item', 'data-q': 'scan' }, ['🔍 快速扫描']),
  ]);

  document.body.append(overlay, bubbleEl, panelEl, scanLayer, dialogWrap, quickMenu);
  rootNodes = [overlay, bubbleEl, panelEl, scanLayer, dialogWrap, quickMenu];

  listEl = document.getElementById('fwh-list');
  listMetaEl = document.getElementById('fwh-meta-total');

  bindEvents();
  applyBubbleStyle();
  refreshOptionsUI();
  renderList();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
function bindEvents() {
  // 关闭
  panelEl.querySelector('.fwh-close').addEventListener('click', closePanel);

  // Tabs
  panelEl.querySelectorAll('.fwh-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      panelEl.querySelectorAll('.fwh-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const page = tab.dataset.tab;
      panelEl.querySelectorAll('.fwh-tabpage').forEach((p) => p.classList.toggle('active', p.dataset.page === page));
    });
  });

  // 扫描按钮
  document.getElementById('btn-scan').addEventListener('click', () => runScan(true));
  document.getElementById('btn-addc').addEventListener('click', () => openEditDialog({ name: '', selector: '', icon: '🪟', }, true));
  document.getElementById('btn-all-on').addEventListener('click', () => setAll(true));
  document.getElementById('btn-all-off').addEventListener('click', () => setAll(false));
  document.getElementById('scan-close').addEventListener('click', () => closeScan());

  // 设置页
  const bindOpts = () => {
    const optSwitches = panelEl.querySelectorAll('.fwh-tabpage[data-page="options"] .fwh-opt-item .fwh-switch');
    optSwitches.forEach((sw, i) => {
      sw.addEventListener('click', () => {
        const on = !sw.classList.contains('on');
        sw.classList.toggle('on', on);
        if (i === 0) settings.options.snapEdges = on;
        else if (i === 1) settings.options.bubbleAutoHide = on;
        else if (i === 2) settings.options.keepPosition = on;
        saveSettings();
      });
    });
  };
  bindOpts();

  document.getElementById('btn-export').addEventListener('click', exportSettings);
  const importFile = document.getElementById('fwh-import-file');
  document.getElementById('btn-import').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', (e) => { if (e.target.files[0]) importSettings(e.target.files[0]); e.target.value = ''; });
  document.getElementById('btn-scan-here').addEventListener('click', () => runScan(true));

  // 收纳列表排列模式切换
  const segBtns = panelEl.querySelectorAll('.fwh-seg-btn[data-layout]');
  segBtns.forEach((b) => {
    b.addEventListener('click', () => {
      settings.options.layoutMode = b.dataset.layout;
      segBtns.forEach((x) => x.classList.toggle('active', x === b));
      saveSettings();
      applyLayoutMode();
      renderList();
    });
  });

  // 对话框
  const wrap = document.getElementById('fwh-dialog-wrap');
  document.getElementById('di-cancel').addEventListener('click', closeEditDialog);
  document.getElementById('di-ok').addEventListener('click', commitEditDialog);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeEditDialog(); });

  // 快捷菜单
  document.getElementById('fwh-quickmenu').querySelectorAll('.qm-item').forEach((it) => {
    it.addEventListener('click', () => {
      const q = it.dataset.q;
      if (q === 'allon') setAll(true);
      else if (q === 'alloff') setAll(false);
      else if (q === 'hide') hideBubble();
      else if (q === 'scan') runScan(false);
      closeQuickMenu();
    });
  });
  document.addEventListener('click', closeQuickMenu);
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#fwh-quickmenu')) closeQuickMenu();
  });

  // 点击面板/悬浮球/快捷菜单之外时收起。改用 pointerdown 而非遮罩的 click：
  // 打开面板的这次触摸会在浏览器合成 click 时落在刚显示的遮罩上，立刻触发 closePanel
  // 造成「面板闪烁后消失」。pointerdown 发生在 openPanel 之前，天然不会误关。
  document.addEventListener('pointerdown', (e) => {
    if (!isPanelOpen) return;
    const t = e.target;
    if (t && t.closest && (t.closest('.fwh-panel') || t.closest('.fwh-bubble') || t.closest('#fwh-quickmenu'))) return;
    closePanel();
  });

  setupDrag();
  setupPanelDrag();   // 面板头部拖动
  setupResize();      // 面板右下角缩放
  applyPanelGeometry(); // 恢复已保存的位置/大小
}

function runScan(showLayer) {
  // 只列出「未收纳」的新增悬浮窗，已收纳的保留在列表中不消失
  const existing = new Set(settings.windows.map((w) => w.selector));
  const found = scanCandidates().filter((f) => !existing.has(f.selector));
  if (found.length === 0) {
    shortToast('没有发现新的悬浮窗（已收纳的保持不变）');
    if (showLayer) closeScan();
    delayedSecondScan();
    return;
  }
  if (showLayer) renderScanList(found);
  else {
    // 快速扫描：直接加入合并
    addFound(found);
    shortToast(`已添加 ${found.length} 个悬浮窗`);
    delayedSecondScan();
  }
}

// 延迟二次扫描：捕获异步 import / 延迟渲染的悬浮窗（如 CE 修改器外链脚本）
function delayedSecondScan() {
  setTimeout(() => {
    const again = scanCandidates();
    let added = 0;
    for (const f of again) {
      if (settings.windows.some((w) => w.selector === f.selector)) continue;
      addWindow({ name: f.name, selector: f.selector, icon: f.icon, triggerSelector: f.triggerSelector, custom: false }, true);
      added++;
    }
    if (added > 0) shortToast(`已延迟捕获 ${added} 个后加载的悬浮窗`);
  }, 1500);
}

function addFound(found) {
  for (const f of found) {
    if (settings.windows.some((w) => w.selector === f.selector)) continue;
    addWindow({ name: f.name, selector: f.selector, icon: f.icon, triggerSelector: f.triggerSelector, custom: false });
  }
}

function renderScanList(found) {
  const list = document.getElementById('fwh-scan-list');
  list.innerHTML = '';
  for (const f of found) {
    const row = el('div', { class: 'fwh-scan-row' }, [
      el('div', { class: 'fwh-scan-ic' }, [iconEl(f.icon, '🪟')]),
      el('div', { class: 'fwh-scan-body' }, [
        el('div', { class: 'fwh-scan-name' }, [f.name]),
        el('div', { class: 'fwh-scan-sel' }, [f.selector]),
      ]),
      el('button', { class: 'fwh-mini primary' }, ['添加']),
    ]);
    row.querySelector('button').addEventListener('click', () => {
      addWindow({ name: f.name, selector: f.selector, icon: f.icon, triggerSelector: f.triggerSelector, custom: false });
      row.remove();
      if (!list.children.length) closeScan();
    });
    list.append(row);
  }
  document.getElementById('fwh-scan').classList.add('open');
}

function closeScan() {
  document.getElementById('fwh-scan').classList.remove('open');
}

function setAll(on) {
  settings.windows.forEach((w) => { w.state = on ? 'open' : 'closed'; w.enabled = on; });
  settings.windows.forEach((w) => applyWindowState(w));
  saveSettings();
  renderList();
  refreshMeta();
}

function hideBubble() {
  settings.bubble.hidden = true;
  bubbleEl.classList.add('fwh-bubble-min');
  saveSettings();
  closeQuickMenu();
  shortToast('悬浮球已最小化，双击设置区域可恢复');
}

function closeQuickMenu() {
  document.getElementById('fwh-quickmenu').classList.remove('open');
}

// ---------------------------------------------------------------------------
// 恢复被最小化的悬浮球:双击页面空白
// ---------------------------------------------------------------------------
function setupRestore() {
  // 桌面端：双击空白处恢复（右键菜单/悬浮球隐藏后唯一入口；移动端不提供长按恢复）
  document.addEventListener('dblclick', (e) => {
    if (!settings.bubble.hidden) return;
    if (e.target.closest && e.target.closest('.fwh-root')) return;
    settings.bubble.hidden = false;
    applyBubbleStyle();
    saveSettings();
    shortToast('悬浮球已恢复显示');
  });
}

// 被酒馆 SPA 清空 body 后自动重新挂载本插件根节点，避免悬浮球/面板消失
function setupKeepAlive() {
  setInterval(() => {
    if (!document.body) return;
    let reattached = false;
    rootNodes.forEach((n) => {
      if (n && !n.isConnected) { document.body.appendChild(n); reattached = true; }
    });
    if (reattached) applyBubbleStyle();
  }, 2000);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
(function run() {
  // 等待 DOM ready
  const start = () => {
    try {
      loadSettings();
      buildDOM();
      refreshMeta();
      // 初始应用各悬浮窗状态(选项 keepPosition 控制是否应用)
      if (!settings.options.keepPosition) {
        settings.windows.forEach((w) => (w.enabled = false));
        saveSettings();
      }
      settings.windows.forEach((w) => applyWindowState(w));
      setupGuard();
      setupRestore();
      setupKeepAlive();
    } catch (err) {
      // 任何初始化异常都不能拖垮宿主页面渲染（早期 WebView 会因未捕获异常黑屏）
      if (typeof console !== 'undefined' && console.error) console.error('[FWH] init error:', err);
    }
  };

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  } catch (err) {
    if (typeof console !== 'undefined' && console.error) console.error('[FWH] boot error:', err);
  }
})();

// ---------------------------------------------------------------------------
// 导出供其它脚本调用(可选)
// ---------------------------------------------------------------------------
window.FloatingWindowHub = {
  open: openPanel,
  close: closePanel,
  toggle: togglePanel,
  addWindow,
  scan: () => scanCandidates(),
  settings: () => settings,
};