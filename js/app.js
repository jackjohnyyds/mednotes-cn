/**
 * app.js — 应用主控制器：底部导航路由、英雄时钟、模块装载、每日自动更新、健康自检与自动修复
 */
import { $, $$, fmtTodayCN, shouldRefreshDaily, markFetched, fetchViaProxy, toast } from './utils.js?v=20261009b';
import { store } from './storage.js?v=20261009b';
import { initFocus, onTabFocus } from './modules/focus.js?v=20261009b';
import { initPapers, onTabPapers, loadPapers } from './modules/papers.js?v=20261009b';
import { initMednews, onTabMednews, loadNews } from './modules/mednews.js?v=20261009b';
import { initBriefing, onTabBriefing, loadBrief } from './modules/briefing.js?v=20261009b';
import { initSpace, onTabSpace } from './modules/space.js?v=20261009b';
import { initSync } from './sync.js?v=20261009b';

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
  // 已取消“切到资讯模块时自动刷新”：内容刷新仅按每日固定时间执行
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

/* ---------- 每日固定时间刷新：默认每日 11:00 刷新一次内容（取消打开页面自动更新） ---------- */
const DAILY_REFRESH_HOUR = 11;
const DAILY_REFRESH_MINUTE = 0;
const DAILY_KEY = 'mednotes_last_daily_refresh';
function todayKeyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getDailyRefreshDate() { try { return localStorage.getItem(DAILY_KEY) || ''; } catch { return ''; } }
function setDailyRefreshDate() { try { localStorage.setItem(DAILY_KEY, todayKeyLocal()); } catch { /* ignore */ } }

/**
 * 每日定时刷新：
 * - 页面打开期间每分钟轮询，到 11:00 自动刷新一次（当天仅一次）；
 * - 若 11:00 后才打开页面且今日尚未刷新，则补刷一次（保证每日内容为当日数据）。
 * 打开页面本身不再触发刷新（不再按 6 小时 / 30 分钟 / 切页判断）。
 */
async function dailyScheduledRefresh() {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  if (hm < DAILY_REFRESH_HOUR * 60 + DAILY_REFRESH_MINUTE) return; // 未到今日刷新时刻
  if (getDailyRefreshDate() === todayKeyLocal()) return;           // 今日已刷新
  await autoDailyRefresh(true);
  setDailyRefreshDate();
}

/* ---------- 每日内容刷新：依次静默刷新全部资讯模块（数据由服务端每日生成，打开页面不自动刷新） ---------- */
async function autoDailyRefresh(force = false) {
  if (!force && !shouldRefreshDaily()) return;
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
  // 为遵守「打开页面不自动抓取外部数据源」，健康自检不再探测 rsshub/PubMed 可达性；
  // 数据可达性由 GitHub Actions 每日生成日志与页面实际渲染结果反映。
  return {};
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

/* ---------- 页面可见性变化刷新已取消（回到页面不再自动更新，仅按每日固定时间刷新） ---------- */

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

  // 启动 8 秒后做每日健康自检与自动修复
  setTimeout(runHealthCheck, 8000);
  // 每日固定时间刷新（默认 11:00）：打开页面时检查今日是否已到点且尚未刷新（到点补刷）；
  // 页面开着时每分钟轮询，到 11:00 自动刷新一次（当天仅一次）。打开页面不再触发自动更新。
  dailyScheduledRefresh();
  setInterval(dailyScheduledRefresh, 60 * 1000);
  // 每 6 小时健康自检（诊断与自愈，非内容自动更新）
  setInterval(runHealthCheck, SIX_HOURS + 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
