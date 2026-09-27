/**
 * app.js — 应用主控制器：底部导航路由、英雄时钟、模块装载、每日自动更新、健康自检与自动修复
 */
import { $, $$, fmtTodayCN, shouldRefreshDaily, markFetched, fetchViaProxy, toast } from './utils.js?v=20260921b';
import { store } from './storage.js?v=20260921b';
import { initFocus, onTabFocus } from './modules/focus.js?v=20260921b';
import { initPapers, onTabPapers, loadPapers } from './modules/papers.js?v=20260921b';
import { initMednews, onTabMednews, loadNews } from './modules/mednews.js?v=20260921b';
import { initBriefing, onTabBriefing, loadBrief } from './modules/briefing.js?v=20260921b';
import { initSpace, onTabSpace } from './modules/space.js?v=20260921b';
import { initSync } from './sync.js?v=20260921b';

const TABS = ['focus', 'papers', 'mednews', 'briefing', 'space'];
// 需要每日自动更新的资讯类模块及其加载器
const LOADERS = { papers: loadPapers, mednews: loadNews, briefing: loadBrief };
const FRESH_KEY = 'mednotes_module_fresh';
const HEALTH_KEY = 'mednotes_health';

function getFreshMap() {
  try { return JSON.parse(localStorage.getItem(FRESH_KEY) || '{}'); } catch { return {}; }
}
function markModuleFresh(name) {
  try {
    const m = getFreshMap();
    m[name] = Date.now();
    localStorage.setItem(FRESH_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}
const SIX_HOURS = 6 * 60 * 60 * 1000;

async function refreshModule(name, { silent = true } = {}) {
  const loader = LOADERS[name];
  if (!loader) return;
  try {
    await loader({ silent });
    markModuleFresh(name);
  } catch (e) {
    console.warn(`[MedNotes] ${name} 自动更新失败:`, e?.message || e);
  }
}

function switchTab(name, { push = false } = {}) {
  if (!TABS.includes(name)) name = 'focus';
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-page').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  store.set('lastTab', name);
  if (push) history.replaceState(null, '', `#${name}`);
  ({ focus: onTabFocus, papers: onTabPapers, mednews: onTabMednews, briefing: onTabBriefing, space: onTabSpace }[name] || (() => {}))();
  // 切到资讯模块时，若数据超过 6 小时则静默刷新（每日自动更新）
  if (LOADERS[name]) {
    const last = getFreshMap()[name] || 0;
    if (Date.now() - last > SIX_HOURS) refreshModule(name, { silent: true });
  }
}

const TAB_RENDER = { focus: onTabFocus, papers: onTabPapers, mednews: onTabMednews, briefing: onTabBriefing, space: onTabSpace };
function rerenderActive() {
  const cur = store.get('lastTab', 'focus');
  const name = TABS.includes(cur) ? cur : 'focus';
  (TAB_RENDER[name] || (() => {}))();
}
// 云端拉取到其他设备的改动后，重绘当前界面
window.addEventListener('mednotes:sync', () => { try { rerenderActive(); } catch (e) { console.warn('[MedNotes] 同步后重绘失败:', e?.message || e); } });

function bindNav() {
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab, { push: true }));
  });
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (TABS.includes(h)) switchTab(h);
  });
}

function greetingFor(h) {
  if (h < 5) return '夜深了，注意休息';
  if (h < 9) return '早上好，新的一天';
  if (h < 12) return '上午好，专注学习';
  if (h < 14) return '中午好，记得午休';
  if (h < 18) return '下午好，继续加油';
  if (h < 22) return '晚上好，复盘今日';
  return '夜深了，早点休息';
}

function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const el = $('#hero-time');
  if (el) el.innerHTML = `${h}<span class="colon">:</span>${m}`;
  const dEl = $('#hero-date');
  if (dEl) dEl.textContent = fmtTodayCN();
  const gEl = $('#greeting-text');
  if (gEl) gEl.textContent = `${greetingFor(now.getHours())} · 白袍手记`;
}

function initClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

/* ---------- 全局错误捕获与自动恢复 ---------- */
function initErrorGuard() {
  window.addEventListener('unhandledrejection', (e) => {
    console.warn('[MedNotes] 异步错误已捕获:', e.reason);
    e.preventDefault();
  });
  window.addEventListener('error', (e) => {
    console.warn('[MedNotes] 脚本错误已捕获:', e.message);
  });
}

/* ---------- 每日自动更新：超过 6 小时静默刷新全部资讯模块（实时聚合，无需服务端定时任务） ---------- */
async function autoDailyRefresh() {
  if (!shouldRefreshDaily()) return;
  markFetched();
  // 依次静默刷新，避免并发压垮免费代理
  for (const name of ['papers', 'mednews', 'briefing']) {
    await refreshModule(name, { silent: true });
    await new Promise((r) => setTimeout(r, 800));
  }
}

/* ---------- 每日健康自检：检查渲染、数据条目、异常链接、数据源可达性，异常自动重载修复 ---------- */
function countRendered(name) {
  if (name === 'papers') return $$('#papers-list .paper-card').length;
  if (name === 'mednews') return $$('#mednews-list .news-item').length;
  if (name === 'briefing') return $$('#brief-view .brief-list.active .brief-item').length;
  return 0;
}
async function probeFeeds() {
  const checks = {};
  // 代理 + 一个国内 RSS
  try {
    const xml = await fetchViaProxy('https://rsshub.rssforever.com/cctv/health', { timeout: 12000 });
    checks.rssProxy = xml.includes('<item') ? 'ok' : 'empty';
  } catch { checks.rssProxy = 'fail'; }
  // PubMed 直连
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=medicine&retmax=1&retmode=json', { signal: ctrl.signal });
    clearTimeout(t);
    checks.pubmed = res.ok ? 'ok' : `http${res.status}`;
  } catch { checks.pubmed = 'fail'; }
  return checks;
}
async function runHealthCheck() {
  const report = { time: new Date().toISOString(), modules: {}, links: {}, feeds: {}, repaired: [] };
  // 1) 模块渲染检查：空模块自动重载一次
  for (const name of ['papers', 'mednews', 'briefing']) {
    const n = countRendered(name);
    report.modules[name] = n;
    if (n === 0) {
      // 仅当该模块曾被初始化（容器存在）才判定异常并尝试自愈
      const containerExists = name === 'papers' ? !!$('#papers-list') : name === 'mednews' ? !!$('#mednews-list') : !!$('#brief-view');
      if (containerExists) {
        await refreshModule(name, { silent: true });
        const after = countRendered(name);
        report.modules[name] = after;
        if (after > 0) report.repaired.push(name);
      }
    }
  }
  // 2) 异常链接检查：不应出现 Google News 重定向或空 href
  const anchors = $$('a.news-link, a.brief-item, a.paper-link');
  let bad = 0;
  anchors.forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href) || /news\.google\.com/i.test(href)) bad += 1;
  });
  report.links = { total: anchors.length, invalid: bad };
  // 3) 数据源可达性
  report.feeds = await probeFeeds();
  try { localStorage.setItem(HEALTH_KEY, JSON.stringify(report)); } catch { /* ignore */ }
  console.info('[MedNotes] 每日自检报告:', report);
  if (report.repaired.length) toast(`已自动修复模块：${report.repaired.join('、')}`);
  return report;
}

/* ---------- 页面可见性变化时刷新（回到页面自动更新） ---------- */
function initVisibilityRefresh() {
  let lastVisible = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const away = Date.now() - lastVisible;
      if (away > 30 * 60 * 1000) autoDailyRefresh();
      lastVisible = Date.now();
    } else {
      lastVisible = Date.now();
    }
  });
}

export function init() {
  initErrorGuard();
  initClock();
  bindNav();

  initFocus();
  initPapers();
  initMednews();
  initBriefing();
  initSpace();

  // 云端同步引擎（自动上传本机操作、跨设备合并）
  initSync();

  // 恢复上次所在标签页
  const saved = store.get('lastTab', 'focus');
  switchTab(TABS.includes(saved) ? saved : 'focus');

  // 启动 3 秒后做每日自动更新（不阻塞首屏，各模块本身已实时聚合）
  setTimeout(autoDailyRefresh, 3000);
  // 启动 8 秒后做每日健康自检与自动修复
  setTimeout(runHealthCheck, 8000);
  // 页面回到前台超过 30 分钟自动刷新
  initVisibilityRefresh();
  // 每 6 小时定时自动更新 + 自检
  setInterval(autoDailyRefresh, SIX_HOURS);
  setInterval(runHealthCheck, SIX_HOURS + 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
