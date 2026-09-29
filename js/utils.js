/**
 * utils.js — 通用工具（日期、DOM、请求、音效、弹窗、Toast）
 */

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** 日期工具 */
const pad2 = (n) => String(n).padStart(2, '0');
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function fmtDateCN(key) {
  const d = parseKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
export function fmtTodayCN() {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
}
export function fmtTimeHM(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch { return ''; }
}
export function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch { return ''; }
}
export function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

/** HTML 转义 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** 相对时间：刚刚 / n分钟前 / n小时前 / 日期 */
export function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = 60e3, hour = 3600e3, day = 86400e3;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)}小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
  return fmtDate(iso);
}

/** 网络请求 */
export async function fetchJSON(url, opts = {}, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
/** 依次尝试多个 URL，全部失败则抛出最后一个错误 */
export async function fetchWithFallback(urls, opts, timeout) {
  let lastErr;
  for (const u of urls) {
    try { return await fetchJSON(u, opts, timeout); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有数据源均不可用');
}

/** 从 Netlify data-api 获取服务端聚合数据（优先），失败返回 null */
export async function fetchApiData(type, { force = false, timeout = 25000 } = {}) {
  try {
    const url = `/.netlify/functions/data-api?type=${type}${force ? '&force=1' : ''}&_=${Date.now()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 多通道抓取跨域文本（RSS/XML）：
 * 1) 直连（源站允许 CORS 时）  2) 公共 CORS 代理  3) 原 Netlify 自建代理（若恢复）
 * 任一通道成功即返回文本，全失败抛错。
 * 说明：已移除 GitHub Pages 上不存在的同源函数路径（/.netlify/functions、/api/proxy），
 * 避免每次刷新先等待 404 超时。
 */
const STABLE_PROXY = 'https://prismatic-cucurucho-9e351c.netlify.app/.netlify/functions/rss-proxy?url=';
export async function fetchViaProxy(targetUrl, { timeout = 12000 } = {}) {
  const channels = [
    targetUrl,
    `https://cors.eu.org/${targetUrl}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    STABLE_PROXY + encodeURIComponent(targetUrl),
  ];
  let lastErr;
  for (const u of channels) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(u, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const text = await res.text();
      // 简单校验：RSS/Atom 或至少是类 XML 内容
      if (text && (text.includes('<item') || text.includes('<entry') || text.includes('<rss') || text.includes('<feed'))) {
        return text;
      }
      lastErr = new Error('返回内容非 RSS');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有代理通道均不可用');
}

/**
 * 抓取任意 HTML / 文本页面（不做 RSS 校验）：用于百度资讯、古诗词网、维基文库等网页解析。
 * 通道顺序与 fetchViaProxy 一致，任一通道返回非空文本即成功。
 */
export async function fetchHtmlViaProxy(targetUrl, { timeout = 14000 } = {}) {
  const channels = [
    targetUrl,
    `https://cors.eu.org/${targetUrl}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    STABLE_PROXY + encodeURIComponent(targetUrl),
  ];
  let lastErr;
  for (const u of channels) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(u, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const text = await res.text();
      if (text && text.trim().length > 40) return text;
      lastErr = new Error('返回内容为空');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有代理通道均不可用');
}

/** 去除 HTML 标签并还原常见实体（用于搜索结果标题/摘要清洗） */
export function stripHtmlTags(s = '') {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 稳定字符串哈希（FNV-1a，用于每日确定性选取） */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 按日期种子从池中确定性选取 n 条（同一天结果稳定，每天自动轮换）。
 * salt 用于同一池在不同位置取不同子集，或“换一批”。
 */
export function dailyPick(pool, count = 10, salt = '') {
  if (!Array.isArray(pool) || !pool.length) return [];
  const seedStr = `${dateKey()}|${salt}`;
  let seed = hashSeed(seedStr);
  const rand = () => { // mulberry32
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = [...pool];
  // Fisher–Yates 洗牌
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

/** 每日自动刷新检查：距上次成功加载超过 6 小时则返回 true */
const STORAGE_KEY_LAST_FETCH = 'mednotes_last_fetch';export function shouldRefreshDaily() {
  try {
    const last = Number(localStorage.getItem(STORAGE_KEY_LAST_FETCH) || 0);
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    return Date.now() - last > SIX_HOURS;
  } catch { return true; }
}
export function markFetched() {
  try { localStorage.setItem(STORAGE_KEY_LAST_FETCH, String(Date.now())); } catch { /* ignore */ }
}

/** 防抖 */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** 提示音（Web Audio，无需音频文件） */
let audioCtx = null;
export function beep(freq = 880, duration = 0.18, volume = 0.22) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch { /* 忽略音频失败 */ }
}
export function playDone() {
  beep(880, 0.2); setTimeout(() => beep(660, 0.2), 240); setTimeout(() => beep(880, 0.34), 480);
}

/** Toast */
let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** 弹窗系统 */
export function openModal(html, { onMount } = {}) {
  closeModal();
  const root = $('#modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  root.appendChild(overlay);
  if (onMount) onMount(overlay);
  return overlay;
}
export function closeModal() {
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
}

/** 生成唯一 id */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 简单文本摘要（取第一句，限长） */
export function firstSentence(text, max = 120) {
  if (!text) return '';
  const plain = String(text).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  const m = plain.match(/^(.+?[。.!?！？])(?:\s|$)/);
  const s = m ? m[1] : plain;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 判断文本是否主要为英文 */
export function isEnglish(text) {
  if (!text) return false;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  return letters > cjk && letters > 10;
}

/**
 * 免费翻译（国内可用、CORS 开放、免 key）：MyMemory 直连 → MyMemory 经代理兜底。
 * 说明：微软 Azure 翻译官方接口需付费订阅密钥，Edge 匿名令牌端点已停用、
 * Bing 网页翻译无 CORS 头无法浏览器直连，故采用 MyMemory 作为稳定免费通道。
 */
const _tCache = new Map();
async function _myMemory(text, from, to, viaProxy) {
  const q = encodeURIComponent(text.slice(0, 480));
  const direct = `https://api.mymemory.translated.net/get?q=${q}&langpair=${from}|${to}`;
  const url = viaProxy ? (STABLE_PROXY + encodeURIComponent(direct)) : direct;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.responseStatus === 200 && j.responseData?.translatedText) {
      const out = j.responseData.translatedText;
      if (/QUERY LENGTH LIMIT|MYMEMORY WARNING/i.test(out)) throw new Error('limit');
      return out;
    }
    throw new Error('bad response');
  } finally { clearTimeout(timer); }
}
export async function translateText(text, from = 'en', to = 'zh-CN') {
  if (!text || !text.trim()) return '';
  const key = `${from}|${to}|${text.slice(0, 480)}`;
  if (_tCache.has(key)) return _tCache.get(key);
  for (const viaProxy of [false, true]) {
    try {
      const out = await _myMemory(text, from, to, viaProxy);
      _tCache.set(key, out);
      return out;
    } catch { /* 尝试下一通道 */ }
  }
  return '';
}

/** 批量翻译（串行避免限流） */
export async function translateBatch(items, from = 'en', to = 'zh-CN') {
  const out = [];
  for (const it of items) {
    out.push(await translateText(it, from, to));
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}
