/**
 * sync.js — 云端同步引擎（白袍手记）
 * 机制：
 *  - 同步码（6 位 Base32）作为跨设备身份，首次自动生成；新设备输入同一同步码即可同步。
 *  - 数据按条目（storage key）记录最后修改时间戳，云端/本地双向 Last-Write-Wins 合并。
 *  - 包装 store.set/del 自动捕获所有本机改动 → 防抖上传；启动 / 定时 / 回前台自动拉取。
 *  - 后端：Netlify Function + Blobs（/.netlify/functions/sync）。
 *  - 离线或后端不可用时静默降级，本地功能不受影响。
 */
import { store, PREFIX, SYNCED_KEYS } from './storage.js?v=20261002a';
import { toast } from './utils.js?v=20261002a';

const SYNC_ENDPOINT = 'https://prismatic-cucurucho-9e351c.netlify.app/.netlify/functions/sync';
// 云端同步后端仅存在于 Netlify 部署；本站点为 GitHub Pages / surge，无该后端 → 禁用云端请求
const CLOUD_ENABLED = location.hostname.includes('netlify.app');
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去除易混 0/1/I/L/O
const PUSH_DEBOUNCE = 1500;
const PULL_INTERVAL = 60 * 1000;

let meta = store.get('syncmeta', { keys: {}, lastPull: 0, lastPush: 0, bound: false });
if (!meta.keys) meta.keys = {};
const applying = new Set(); // 正在应用云端数据的 key，避免回环触发推送
let pushTimer = null;
let inFlight = false;
let dirty = false;

function saveMeta() { localStorage.setItem(PREFIX + 'syncmeta', JSON.stringify(meta)); }

function genCode() {
  let c = '';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) c += ALPHABET[buf[i] % ALPHABET.length];
  return c;
}
function getCode() {
  let code = store.get('synccode');
  if (!code || !/^[A-Z2-9]{6}$/.test(code)) {
    code = genCode();
    localStorage.setItem(PREFIX + 'synccode', JSON.stringify(code));
  }
  return code;
}

/* ---------- 包装本地数据层，自动捕获改动 ---------- */
const origSet = store.set.bind(store);
const origDel = store.del.bind(store);
function markDirty(key) {
  meta.keys[key] = Date.now();
  saveMeta();
  dirty = true;
  schedulePush();
}
store.set = (key, value) => {
  const r = origSet(key, value);
  if (SYNCED_KEYS.includes(key) && !applying.has(key)) markDirty(key);
  return r;
};
store.del = (key) => {
  const r = origDel(key);
  if (SYNCED_KEYS.includes(key) && !applying.has(key)) markDirty(key);
  return r;
};

/* ---------- 状态展示 ---------- */
function setStatus(text, tone) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone || 'idle';
}
function hhmmss(t) {
  if (!t) return '--';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/* ---------- 本地条目收集（用于上传） ---------- */
function collectLocalKeys() {
  const now = Date.now();
  const keys = {};
  for (const key of SYNCED_KEYS) {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) continue;
    let value;
    try { value = JSON.parse(raw); } catch { continue; }
    // 首次全量上传：本机已有但无时间戳的条目，视为当前最新
    const ts = meta.keys[key] || now;
    keys[key] = { value, ts };
    meta.keys[key] = ts;
  }
  saveMeta();
  return keys;
}

/* ---------- 拉取并合并云端数据 ---------- */
async function pull() {
  const code = getCode();
  const res = await fetch(`${SYNC_ENDPOINT}?code=${code}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`pull HTTP ${res.status}`);
  const j = await res.json();
  const remote = (j && j.data && j.data.keys) || {};
  let changed = false;
  applying.add('__all__');
  for (const [key, entry] of Object.entries(remote)) {
    if (!SYNCED_KEYS.includes(key)) continue;
    const cts = Number(entry.ts || 0);
    const lts = Number(meta.keys[key] || 0);
    if (cts > lts) {
      if (entry.value === null) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, JSON.stringify(entry.value));
      meta.keys[key] = cts;
      changed = true;
    }
  }
  applying.delete('__all__');
  meta.lastPull = Date.now();
  saveMeta();
  if (changed) window.dispatchEvent(new CustomEvent('mednotes:sync'));
  return changed;
}

/* ---------- 推送（服务端按时间戳合并，安全可重入） ---------- */
async function push() {
  const code = getCode();
  const keys = collectLocalKeys();
  const res = await fetch(SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, keys }),
  });
  if (!res.ok) throw new Error(`push HTTP ${res.status}`);
  meta.lastPush = Date.now();
  saveMeta();
  dirty = false;
}

/* ---------- 一次完整同步：先拉后推，串行防冲突 ---------- */
async function syncOnce(manual) {
  if (inFlight) return;
  inFlight = true;
  setStatus('同步中…', 'busy');
  try {
    await pull();
    await push();
    setStatus(`已同步 ${hhmmss(meta.lastPush)}`, 'ok');
    if (manual) toast('云端同步完成');
  } catch (e) {
    setStatus('离线，稍后自动重试', 'err');
    if (manual) toast('同步失败：' + (e.message || '网络不可用'));
  } finally {
    inFlight = false;
  }
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { if (!document.hidden) syncOnce(false); }, PUSH_DEBOUNCE);
}

/* ---------- 绑定其他设备的同步码 ---------- */
async function bindCode(code) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) { toast('同步码应为 6 位字符'); return; }
  localStorage.setItem(PREFIX + 'synccode', JSON.stringify(code));
  meta.bound = true;
  // 绑定后保留本机数据时间戳，与云端做 LWW 合并（不会丢失本机内容）
  saveMeta();
  renderPanel();
  await syncOnce(true);
}

/* ---------- 面板渲染与事件 ---------- */
export function renderPanel() {
  const codeEl = document.getElementById('sync-code');
  if (codeEl) codeEl.textContent = getCode();
}

function initUI() {
  renderPanel();
  const copyBtn = document.getElementById('sync-copy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const code = getCode();
    try {
      await navigator.clipboard.writeText(code);
      toast('同步码已复制：' + code);
    } catch {
      toast('同步码：' + code);
    }
  });
  // 云端按钮（绑定/手动同步）仅在站点部署了 Netlify 同步后端时可用
  if (!CLOUD_ENABLED) return;
  const bindBtn = document.getElementById('sync-bind');
  const nowBtn = document.getElementById('sync-now');
  const input = document.getElementById('sync-input');
  if (bindBtn) bindBtn.addEventListener('click', () => bindCode(input ? input.value : ''));
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') bindCode(input.value); });
  if (nowBtn) nowBtn.addEventListener('click', () => syncOnce(true));
}

/* ---------- 启动 ---------- */
export function initSync() {
  initUI();
  if (!CLOUD_ENABLED) {
    // 本站点（GitHub Pages / surge）未部署 Netlify 同步后端：
    // 禁用云端同步请求（否则启动/定时/写操作都会持续请求已失效的后端），
    // 数据全部保存在本机，不影响收藏、病例、打卡等本地功能。
    setStatus('本地模式（无云端后端）', 'idle');
    return;
  }
  setStatus('准备同步…', 'busy');
  // 包装期间 applying 未用 __all__ 拦截初始化迁移写入，延迟首次同步让本地迁移先完成
  setTimeout(() => syncOnce(false), 1500);
  setInterval(() => { if (!document.hidden) pull().then(() => { if (dirty) return push(); }).catch(() => {}); }, PULL_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncOnce(false);
  });
  window.addEventListener('online', () => syncOnce(false));
  // 页面关闭前尽力把残留改动发出（服务端按时间戳合并，不会覆盖他端）
  window.addEventListener('pagehide', () => {
    if (!dirty) return;
    try {
      const code = getCode();
      const keys = collectLocalKeys();
      navigator.sendBeacon(SYNC_ENDPOINT, new Blob([JSON.stringify({ code, keys })], { type: 'application/json' }));
    } catch { /* ignore */ }
  });
}
