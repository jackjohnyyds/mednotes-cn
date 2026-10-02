/**
 * briefing.js — 天下简报（按来源分六栏：央视网 / China Daily / 澎湃新闻 / 36氪 / 全球外网 / 梨视频）
 * 每个来源聚合其多个频道，自动覆盖时政、国际、财经、科技、社会、文化等板块；
 * 跨频道 / 跨来源去重；英文来源（China Daily、全球外网）标题自动翻译为中文；
 * 全部为原文直链，点击新标签打开原网站（梨视频点击跳转播放页），不使用 Google News 等重定向链接。
 * 数据链路：静态 JSON 秒开 → 始终在线聚合（RSSHub / 官方直链 RSS / China Daily 频道页 HTML）覆盖。
 */
import { $, $$, esc, fetchWithFallback, fetchApiData, fetchViaProxy, fetchHtmlViaProxy, relTime, isEnglish, translateText } from '../utils.js?v=20261003a';
import { historyAdd } from '../storage.js?v=20261003a';

const RSSHUB_INSTANCES = ['https://rsshub.rssforever.com', 'https://rsshub.app'];
const PER_TAB = 24; // 每栏最终展示条数

/* 六栏（按来源） */
const TAB_ORDER = ['cctv', 'chinadaily', 'thepaper', 'kr36', 'global', 'pearvideo'];
const TAB_LABEL = {
  cctv: '央视网',
  chinadaily: 'China Daily',
  thepaper: '澎湃新闻',
  kr36: '36氪',
  global: '全球外网',
  pearvideo: '梨视频',
};

/* 央视网：聚合国内 / 世界 / 科技三个频道（中文，原文直链） */
const CCTV_FEEDS = [
  { route: '/cctv/china', limit: 9 },
  { route: '/cctv/world', limit: 8 },
  { route: '/cctv/tech', limit: 8 },
];

/* China Daily：频道页 HTML 解析（英文，聚合国内/世界/商业/文化/观点，自动翻译） */
const CD_SECTIONS = [
  { sec: 'china', limit: 8 },
  { sec: 'world', limit: 7 },
  { sec: 'business', limit: 6 },
  { sec: 'culture', limit: 5 },
  { sec: 'opinion', limit: 5 },
];

/* 澎湃新闻：热门综合（中文，覆盖社会 / 时政 / 财经 / 文化） */
const THEPAPER_FEEDS = [{ route: '/thepaper/featured', limit: PER_TAB }];

/* 36氪：快讯流（中文，覆盖科技 / 商业 / 财经） */
const KR36_FEEDS = [{ route: '/36kr/newsflashes', limit: PER_TAB }];

/* 全球外网：多家国际媒体多板块（英文，自动翻译），轮流取以保证多元 */
const GLOBAL_FEEDS = [
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', limit: 4 },
  { name: '卫报国际', url: 'https://www.theguardian.com/world/rss', limit: 4 },
  { name: 'BBC 科技', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', limit: 3 },
  { name: '卫报科技', url: 'https://www.theguardian.com/technology/rss', limit: 3 },
  { name: 'BBC 商业', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', limit: 3 },
  { name: '卫报商业', url: 'https://www.theguardian.com/uk/business/rss', limit: 3 },
  { name: 'NPR 头条', url: 'https://feeds.npr.org/1001/rss.xml', limit: 3 },
  { name: '半岛电视台', url: 'https://www.aljazeera.com/xml/rss/all.xml', limit: 3 },
];

let briefCache = [];
let briefMeta = '';
let activeTab = 'cctv';
let loadSeq = 0;

function tabById(id) { return briefCache.find((c) => c.id === id); }

/* ---------------- 去重 ---------------- */
function normTitle(t) {
  return (t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 40);
}
function normLink(l) {
  return (l || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
}
function dedup(items) {
  const seenLink = new Set();
  const seenTitle = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !it.link || !/^https?:\/\//i.test(it.link)) continue;
    const lk = normLink(it.link);
    const tt = normTitle(it.titleCn || it.title);
    if (seenLink.has(lk)) continue;
    if (tt && seenTitle.has(tt)) continue;
    seenLink.add(lk);
    if (tt) seenTitle.add(tt);
    out.push(it);
  }
  return out;
}
/** 多个来源轮流交错，避免被单一频道 / 媒体刷屏 */
function roundRobin(groups, max) {
  const out = [];
  const queues = groups.map((g) => g.slice());
  let added = true;
  while (added && out.length < max) {
    added = false;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); added = true; }
      if (out.length >= max) break;
    }
  }
  return out;
}
function byTime(items) {
  return items.slice().sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
}

/* ---------------- 渲染 ---------------- */
function renderBriefTabs() {
  const wrap = $('#brief-tabs');
  if (!briefCache.length) { wrap.innerHTML = '<span class="empty-note">暂无数据</span>'; return; }
  wrap.innerHTML = TAB_ORDER
    .map((id) => tabById(id))
    .filter(Boolean)
    .map((c) => `<button class="filter-chip ${c.id === activeTab ? 'active' : ''}" data-tab="${c.id}">${c.label}</button>`)
    .join('');
  $$('#brief-tabs .filter-chip').forEach((b) => {
    b.addEventListener('click', () => { activeTab = b.dataset.tab; renderBriefTabs(); renderBriefView(); });
  });
}

function renderBriefView() {
  const view = $('#brief-view');
  view.innerHTML = briefCache.map((c) => `
    <div class="brief-list ${c.id === activeTab ? 'active' : ''}" data-tab="${c.id}">
      ${c.items.map((it) => {
        const main = it.titleCn || it.title;
        const showEn = it.titleCn && it.title && it.titleCn !== it.title;
        return `
        <a class="brief-item" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer"
           data-link="${esc(it.link)}" data-title="${esc(main)}">
          <div class="brief-title">${esc(main)}</div>
          ${showEn ? `<div class="brief-title-en" style="font-size:0.85em;color:var(--text-2,#889);margin-top:2px;">${esc(it.title)}</div>` : ''}
          <div class="brief-meta">
            <span class="chip">${esc(it.source || TAB_LABEL[c.id] || '未知来源')}</span>
            <span>${relTime(it.time)}</span>
            <span style="opacity:0.6;">${it.type === 'video' ? '播放 ↗' : '原文 ↗'}</span>
          </div>
        </a>`;
      }).join('') || '<div class="empty-note" style="text-align:center;padding:24px 0;">该栏目暂无数据</div>'}
    </div>`).join('');

  $$('#brief-view a.brief-item').forEach((item) => {
    item.addEventListener('click', () => {
      const link = item.dataset.link;
      const title = item.dataset.title;
      if (link && title) historyAdd({ type: 'brief', title, url: link });
    });
  });
}

function renderBriefMeta() { $('#briefing-meta').textContent = briefMeta || ''; }
function renderSkeletons() {
  $('#brief-view').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('#briefing-status').innerHTML = '<div class="spin"></div>正在获取今日简报…';
}

/* ---------------- RSS 抓取（原文直链） ---------------- */
function cleanText(v) {
  v = v.replace(/<!\[CDATA\[|\]\]>/g, '');
  v = v.replace(/\[!--begin:[a-zA-Z]+--\][\s\S]*?\[!--end:[a-zA-Z]+--\]/g, ' ');
  v = v.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\[!--[\s\S]*?--\]/g, ' ');
  v = v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
       .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  v = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return v;
}
async function fetchRSSUrl(url, sourceName, limit = 8, timeoutMs = 14000) {
  try {
    const text = await fetchViaProxy(url, { timeout: timeoutMs });
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(text))) {
      const block = m[1];
      const get = (tag) => {
        const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
        return mm ? cleanText(mm[1]) : '';
      };
      const title = get('title');
      let link = get('link');
      if (!link) { const x = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i); link = x ? cleanText(x[1]) : ''; }
      const pubDate = get('pubDate') || get('date');
      if (title && link && /^https?:\/\//i.test(link) && !/news\.google\.com|rsshub\./i.test(link)) {
        items.push({ title, link, time: pubDate, source: sourceName });
      }
      if (items.length >= limit) break;
    }
    return items;
  } catch { return []; }
}
async function fetchRsshub(route, name, limit) {
  for (const inst of RSSHUB_INSTANCES) {
    const items = await fetchRSSUrl(inst + route, name, limit);
    if (items.length) return items;
  }
  return [];
}

/* ---------------- China Daily 频道页 HTML 解析（英文原文直链） ---------------- */
const CD_RE = /<a[^>]+href="(?:https?:)?\/\/www\.chinadaily\.com\.cn\/a\/(\d{4})(\d{2})\/(\d{2})\/(WS?[A-Za-z0-9_]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
async function fetchChinaDailySection({ sec, limit }) {
  const url = `https://www.chinadaily.com.cn/${sec}/`;
  try {
    const html = await fetchHtmlViaProxy(url, { timeout: 16000 });
    const map = new Map();
    let m;
    while ((m = CD_RE.exec(html))) {
      const link = `https://www.chinadaily.com.cn/a/${m[1]}${m[2]}/${m[3]}/${m[4]}`;
      const title = cleanText(m[5]);
      if (title.length < 15 || /^(Photo|Video|Infographic|Special|Gallery)/i.test(title)) continue;
      if (!map.has(link)) {
        map.set(link, {
          title, link,
          time: `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`,
          source: 'China Daily', english: true,
        });
      }
    }
    return [...map.values()].slice(0, limit);
  } catch { return []; }
}

/* ---------------- 各栏目构建 ---------------- */
async function buildCctv() {
  const groups = await Promise.all(CCTV_FEEDS.map((f) => fetchRsshub(f.route, '央视网', f.limit)));
  const items = dedup(roundRobin(groups, PER_TAB));
  return { id: 'cctv', label: TAB_LABEL.cctv, items };
}
async function buildChinaDaily() {
  const groups = await Promise.all(CD_SECTIONS.map(fetchChinaDailySection));
  const items = dedup(roundRobin(groups, PER_TAB));
  items.forEach((it) => { it.english = true; });
  return { id: 'chinadaily', label: TAB_LABEL.chinadaily, items };
}
async function buildThepaper() {
  const groups = await Promise.all(THEPAPER_FEEDS.map((f) => fetchRsshub(f.route, '澎湃新闻', f.limit)));
  return { id: 'thepaper', label: TAB_LABEL.thepaper, items: dedup(byTime(groups.flat())).slice(0, PER_TAB) };
}
async function buildKr36() {
  const groups = await Promise.all(KR36_FEEDS.map((f) => fetchRsshub(f.route, '36氪', f.limit)));
  return { id: 'kr36', label: TAB_LABEL.kr36, items: dedup(byTime(groups.flat())).slice(0, PER_TAB) };
}
async function buildGlobal() {
  const groups = await Promise.all(GLOBAL_FEEDS.map(async (f) => {
    const arr = await fetchRSSUrl(f.url, f.name, f.limit);
    arr.forEach((it) => { it.english = true; });
    return arr;
  }));
  const items = dedup(roundRobin(groups, PER_TAB));
  return { id: 'global', label: TAB_LABEL.global, items };
}

/* 梨视频：官网热门页 HTML 解析（浏览器端无 CORS 时兜底为空，静态数据为主通道） */
async function buildPearvideo() {
  try {
    const html = await fetchViaProxy('https://www.pearvideo.com/', { timeout: 12000 });
    const items = [];
    const re = /<a[^>]+href="(video_\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const tm = /<div class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(m[2]);
      const title = tm ? tm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      if (!title) continue;
      items.push({ title: title.slice(0, 60), link: 'https://www.pearvideo.com/' + m[1], source: '梨视频', type: 'video' });
      if (items.length >= PER_TAB) break;
    }
    return { id: 'pearvideo', label: TAB_LABEL.pearvideo, items: dedup(items) };
  } catch {
    return { id: 'pearvideo', label: TAB_LABEL.pearvideo, items: [] };
  }
}

const BUILDERS = { cctv: buildCctv, chinadaily: buildChinaDaily, thepaper: buildThepaper, kr36: buildKr36, global: buildGlobal, pearvideo: buildPearvideo };

/* 后台翻译英文标题（China Daily、全球外网），逐条完成即重渲染 */
async function translateTabs() {
  for (const c of briefCache) {
    let changed = false;
    for (const it of c.items) {
      if (!it.english || !isEnglish(it.title) || it.titleCn) continue;
      let cn = '';
      try { cn = await translateText(it.title.slice(0, 300)); } catch { cn = ''; }
      if (cn) { it.titleCn = cn; changed = true; if (c.id === activeTab) renderBriefView(); }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (changed && c.id === activeTab) renderBriefView();
  }
  renderBriefTabs();
  if (tabById(activeTab)) renderBriefView();
}

/* ---------------- 数据装载 ---------------- */
function adoptTabs(cats) {
  // 实时结果按栏目合并；某栏目实时为空时保留上一次（静态兜底）数据，避免单源失败清空整栏
  const prev = new Map(briefCache.map((c) => [c.id, c]));
  briefCache = TAB_ORDER.map((id) => {
    const c = cats.find((x) => x.id === id);
    const items = (c && Array.isArray(c.items) && c.items.length)
      ? c.items
      : (prev.get(id)?.items || []);
    return { id, label: TAB_LABEL[id] || c?.label || id, items };
  });
}

function hasContent() {
  return briefCache.some((c) => c.items && c.items.length);
}
async function loadApiBrief() {
  const data = await fetchApiData('briefing');
  if (data && Array.isArray(data.briefing) && data.briefing.some((c) => c.items?.length)) {
    adoptTabs(data.briefing);
    if (!hasContent()) return false; // 旧板块结构（id 不匹配），交给静态 / 实时通道
    briefMeta = `每日聚合更新（更新于 ${new Date(data.lastUpdated).toLocaleString('zh-CN')}）`;
    return true;
  }
  return false;
}
async function loadLocalBrief() {
  try {
    const data = await fetchWithFallback([`data/briefing.json?v=${Date.now()}`]);
    const cats = data?.categories || data?.briefing;
    if (data && Array.isArray(cats) && cats.some((c) => c.items?.length)) {
      adoptTabs(cats);
      if (!hasContent()) return false;
      briefMeta = data.lastUpdated
        ? `每日数据（更新于 ${new Date(data.lastUpdated).toLocaleString('zh-CN')}）` : '每日数据';
      return true;
    }
  } catch { /* 下一级 */ }
  return false;
}
async function loadLiveBrief() {
  const seq = ++loadSeq;
  const results = await Promise.allSettled(TAB_ORDER.map((id) => BUILDERS[id]()));
  if (seq !== loadSeq) return false;
  const built = results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  if (!built.length) return false;
  adoptTabs(built);
  briefMeta = `实时聚合 · 多频道原文直链（更新于 ${new Date().toLocaleString('zh-CN')}）`;
  translateTabs(); // 后台翻译，不阻塞渲染
  return true;
}

export async function loadBrief({ silent = false } = {}) {
  if (!silent) renderSkeletons();
  // 1) 服务端聚合 API（若已部署）
  if (await loadApiBrief()) { finish(); return; }
  // 2) 每日静态数据（GitHub Actions 每日生成），优先读取，秒开且稳定
  let hasLocal = await loadLocalBrief();
  if (hasLocal) { finish(); return; }
  // 3) 仅当无每日静态数据时才实时聚合（打开页面不触发实时抓取）
  try {
    if (await loadLiveBrief()) hasLocal = true;
  } catch { /* 失败保留静态数据 */ }
  if (hasLocal) { finish(); }
  else {
    $('#brief-view').innerHTML = '';
    renderBriefMeta();
    $('#briefing-status').innerHTML = `
      <p>暂时无法获取简报数据，请稍后重试。</p>
      <button class="btn btn-ghost retry-btn" id="briefing-retry">重试</button>`;
    $('#briefing-retry')?.addEventListener('click', () => loadBrief());
  }
  function finish() {
    renderBriefMeta();
    renderBriefTabs();
    renderBriefView();
    $('#briefing-status').innerHTML = '';
  }
}

export function initBriefing() {
  $('#briefing-refresh').addEventListener('click', () => loadBrief());
  loadBrief();
}

export function onTabBriefing() {
  renderBriefMeta();
  renderBriefTabs();
  renderBriefView();
}
