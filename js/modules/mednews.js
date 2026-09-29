/**
 * mednews.js — 临床医讯（国内+国际+互联网媒体，英文自动翻译）
 * 数据链路：Netlify data-api（首选）→ 静态 JSON → RSS 代理
 */
import { $, $$, esc, toast, fetchWithFallback, fetchApiData, fetchViaProxy, fetchHtmlViaProxy, stripHtmlTags, relTime, debounce, isEnglish, translateText } from '../utils.js?v=20260929b';
import { historyAdd } from '../storage.js?v=20260929b';

/**
 * 新闻源配置：全部为原文直链（不使用 Google News 重定向）
 * route 为 RSSHub 路径（自动在多个实例间容错）；url 为官方直连 RSS
 * filter 为关键词过滤（用于综合类板块筛出健康相关条目）
 */
const RSSHUB_INSTANCES = [
  'https://rsshub.rssforever.com',
  'https://rsshub.app',
];
const NEWS_FEEDS = [
  // 国内权威媒体健康板块（RSSHub，原文直链）
  { name: '央视网健康', route: '/cctv/health', limit: 8 },
  { name: '人民网健康', route: '/people/health', limit: 8 },
  { name: '澎湃新闻', route: '/thepaper/featured', limit: 6,
    filter: ['健康', '医', '药', '病', '疫', '卫生', '医院', '治疗', '防控', '医保', '养生'] },
  // 国际权威（官方 RSS，原文直链）
  { name: 'WHO 新闻', url: 'https://www.who.int/rss-feeds/news-english.xml', limit: 8, english: true },
  { name: 'BBC Health', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', limit: 6, english: true },
];

let newsCache = [];
let newsMeta = '';
let activeSource = 'all';
let searchText = '';
let translatedIdx = new Set();

/* ---------- 栏目：临床要闻 / 疾病治疗进展 / 药物进展（后两者来自百度资讯搜索，国内媒体直链） ---------- */
let activeCat = 'main';
const CAT_META = {
  disease: { label: '疾病治疗进展', queries: ['疾病治疗新进展', '临床治疗突破'] },
  drug: { label: '药物进展', queries: ['新药获批上市', '创新药研发进展'] },
};
const progressCache = { disease: [], drug: [] };
const progressLoaded = { disease: false, drug: false };

/** 解析百度资讯搜索结果页（结果块内嵌 <!--s-data:{...}--> JSON） */
function parseBaiduNews(html) {
  const out = [];
  const seen = new Set();
  const blocks = html.match(/<!--s-data:[\s\S]*?-->/g) || [];
  for (const b of blocks) {
    const json = b.replace(/^<!--s-data:/, '').replace(/-->$/, '');
    let d;
    try { d = JSON.parse(json); } catch { continue; }
    if (!d || !d.titleUrl || !d.title) continue;
    const link = String(d.titleUrl).replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(link) || seen.has(link)) continue;
    seen.add(link);
    out.push({
      title: stripHtmlTags(d.title),
      link,
      source: d.sourceName || '百度资讯',
      time: '',
      timeText: d.dispTime || '',
      summary: stripHtmlTags(d.summary || '').slice(0, 140),
      english: false,
    });
  }
  return out;
}

/** 抓取一个进展栏目：主关键词命中≥8条即停（百度资讯对连续请求限流），不足再用备用词补抓 */
async function fetchProgressCat(cat) {
  const meta = CAT_META[cat];
  const merged = [];
  const seen = new Set();
  for (let qi = 0; qi < meta.queries.length; qi++) {
    const kw = meta.queries[qi];
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(kw)}&tn=news&rtt=1`;
    try {
      const html = await fetchHtmlViaProxy(url, { timeout: 16000 });
      for (const it of parseBaiduNews(html)) {
        if (!seen.has(it.link)) { seen.add(it.link); merged.push(it); }
      }
    } catch { /* 单个关键词失败则跳过 */ }
    if (merged.length >= 8) break;
    if (qi < meta.queries.length - 1) await new Promise((r) => setTimeout(r, 2600));
  }
  return merged.slice(0, 15);
}

function renderCats() {
  const wrap = $('#mednews-cats');
  if (!wrap) return;
  wrap.innerHTML =
    `<button class="filter-chip ${activeCat === 'main' ? 'active' : ''}" data-cat="main">临床要闻</button>` +
    Object.keys(CAT_META).map((c) =>
      `<button class="filter-chip ${activeCat === c ? 'active' : ''}" data-cat="${c}">${CAT_META[c].label}</button>`).join('');
}

function renderProgressSkeleton(cat) {
  $('#mednews-list').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('#mednews-status').innerHTML = `<div class="spin"></div>正在获取${CAT_META[cat].label}…`;
}

async function switchCat(cat) {
  activeCat = cat;
  searchText = '';
  const searchInput = $('#mednews-search');
  if (searchInput) searchInput.value = '';
  renderCats();
  $('#mednews-sources').style.display = cat === 'main' ? '' : 'none';

  if (cat === 'main') {
    $('#mednews-meta').textContent = newsMeta || '';
    renderSources();
    renderNews();
    return;
  }
  $('#mednews-meta').textContent = `${CAT_META[cat].label} · 来源：百度资讯聚合国内媒体（原文直链）`;
  if (progressLoaded[cat] && progressCache[cat].length) { renderNews(); $('#mednews-status').innerHTML = ''; return; }
  renderProgressSkeleton(cat);
  try {
    const items = await fetchProgressCat(cat);
    progressCache[cat] = items;
    progressLoaded[cat] = true;
    renderNews();
    $('#mednews-status').innerHTML = items.length
      ? ''
      : `<p>暂时无法获取${CAT_META[cat].label}，请稍后重试。</p><button class="btn btn-ghost retry-btn" data-retry-cat="${cat}">重试</button>`;
  } catch {
    $('#mednews-status').innerHTML = `<p>${CAT_META[cat].label}获取失败，请稍后重试。</p><button class="btn btn-ghost retry-btn" data-retry-cat="${cat}">重试</button>`;
  }
}

function renderSkeletons() {
  $('#mednews-list').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('#mednews-status').innerHTML = '<div class="spin"></div>正在获取今日医讯…';
}

function renderNews() {
  const kw = searchText.trim().toLowerCase();
  const src = activeCat === 'main' ? newsCache : (progressCache[activeCat] || []);
  const list = src.filter((n) => {
    if (activeCat === 'main' && activeSource !== 'all' && n.source !== activeSource) return false;
    if (kw && !((n.title || '').toLowerCase().includes(kw) || (n.summary || '').toLowerCase().includes(kw))) return false;
    return true;
  });
  const wrap = $('#mednews-list');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-note" style="text-align:center;padding:20px 0;">没有符合条件的医讯</div>';
    return;
  }
  wrap.innerHTML = list.map((n) => `
    <div class="news-item" data-link="${esc(n.link)}" data-title="${esc(n.titleCn || n.title)}">
      <a class="news-link" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
        <div class="news-title">${esc(n.titleCn || n.title)}</div>
        ${n.titleCn && n.title && n.titleCn !== n.title ? `<div class="news-title-en" style="font-size:0.85em;color:var(--text-2,#889);margin-top:2px;">${esc(n.title)}</div>` : ''}
        ${n.summary ? `<div class="news-summary">${esc(n.summaryCn || n.summary)}</div>` : ''}
        <div class="news-meta">
          <span class="chip">${esc(n.source || '未知来源')}</span>
          <span>${n.timeText ? esc(n.timeText) : relTime(n.time)}</span>
          <span style="opacity:0.6;">原文 ↗</span>
        </div>
      </a>
    </div>`).join('');
}

function renderSources() {
  const wrap = $('#mednews-sources');
  const sources = [...new Set(newsCache.map((n) => n.source).filter(Boolean))];
  wrap.innerHTML = `<button class="filter-chip ${activeSource === 'all' ? 'active' : ''}" data-source="all">全部</button>` +
    sources.map((s) => `<button class="filter-chip ${activeSource === s ? 'active' : ''}" data-source="${esc(s)}">${esc(s)}</button>`).join('');
}

function renderNewsMeta() {
  if (activeCat !== 'main') {
    $('#mednews-meta').textContent = `${CAT_META[activeCat].label} · 百度资讯聚合国内媒体（原文直链）`;
    return;
  }
  $('#mednews-meta').textContent = newsMeta || '';
}

/** 自动翻译英文新闻标题和摘要 */
async function autoTranslateNews(items) {
  const needsTrans = items.filter((n) => isEnglish(n.title));
  for (let i = 0; i < needsTrans.length; i++) {
    const n = needsTrans[i];
    const cn = await translateText(n.title);
    if (cn) n.titleCn = cn;
    if (n.summary && isEnglish(n.summary)) {
      const scn = await translateText(n.summary);
      if (scn) n.summaryCn = scn;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return items;
}

/* ---------- 数据源 0：Netlify data-api（首选） ---------- */
async function loadApiNews() {
  const data = await fetchApiData('mednews');
  if (data && Array.isArray(data.mednews) && data.mednews.length) {
    newsCache = data.mednews;
    newsMeta = `每日聚合更新（更新于 ${new Date(data.lastUpdated).toLocaleString('zh-CN')}）`;
    autoTranslateNews(newsCache).then(() => { renderNews(); renderSources(); });
    return true;
  }
  return false;
}

async function loadLocalNews() {
  try {
    const data = await fetchWithFallback([`data/mednews.json?v=${Date.now()}`]);
    if (data && Array.isArray(data.items) && data.items.length) {
      newsCache = data.items;
      newsMeta = data.lastUpdated
        ? `每日数据（更新于 ${new Date(data.lastUpdated).toLocaleString('zh-CN')}）`
        : '每日数据';
      // 预填疾病治疗进展 / 药物进展静态兜底
      if (data.progress) {
        for (const c of ['disease', 'drug']) {
          if (Array.isArray(data.progress[c]) && data.progress[c].length) {
            progressCache[c] = data.progress[c];
            progressLoaded[c] = true;
          }
        }
      }
      // 对英文条目自动翻译
      autoTranslateNews(newsCache).then(() => { if (activeCat === 'main') { renderNews(); renderSources(); } });
      return true;
    }
  } catch { /* 下一级 */ }
  return false;
}

/** 通过多通道代理抓取并解析单个 RSS 源（返回原文直链） */
async function fetchRSSUrl(url, sourceName, limit = 8, timeoutMs = 12000) {
  try {
    const text = await fetchViaProxy(url, { timeout: timeoutMs });
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(text))) {
      const block = m[1];
      const get = (tag) => {
        const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
        if (!mm) return '';
        let v = mm[1].replace(/<!\[CDATA\[|\]\]>/g, '');
        // 去除 HTML 注释与央视 begin/end 嵌入块（视频/图集代码）及残留标签
        v = v.replace(/\[!--begin:[a-zA-Z]+--\][\s\S]*?\[!--end:[a-zA-Z]+--\]/g, ' ');
        v = v.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\[!--[\s\S]*?--\]/g, ' ');
        v = v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
             .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
        v = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return v;
      };
      const title = get('title');
      const link = get('link');
      const pubDate = get('pubDate');
      let desc = get('description');
      if (desc.length > 160) desc = desc.slice(0, 160) + '…';
      // 只保留 http(s) 原文直链，排除任何聚合站重定向
      if (title && link && /^https?:\/\//i.test(link) && !/news\.google\.com|rsshub/i.test(link)) {
        items.push({ title, link, time: pubDate, source: sourceName, summary: desc });
      }
      if (items.length >= limit) break;
    }
    return items;
  } catch { return []; }
}

/** 抓取一个新闻源配置：RSSHub 路由自动多实例容错，直连 URL 直接抓取 */
async function fetchFeed(feed) {
  const { name, route, url, limit = 8, filter: kw, english = false } = feed;
  let items = [];
  if (route) {
    // RSSHub 路由：依次尝试多个公共实例
    for (const inst of RSSHUB_INSTANCES) {
      items = await fetchRSSUrl(inst + route, name, limit);
      if (items.length) break;
    }
  } else if (url) {
    items = await fetchRSSUrl(url, name, limit);
  }
  // 综合类板块按健康关键词过滤
  if (kw && kw.length) {
    items = items.filter((it) => {
      const hay = (it.title + ' ' + (it.summary || ''));
      return kw.some((k) => hay.includes(k));
    });
  }
  items.forEach((it) => { it.english = english; });
  return items;
}

/** 聚合所有新闻源（并行，独立容错） */
async function aggregateAllFeeds() {
  const results = await Promise.allSettled(NEWS_FEEDS.map((f) => fetchFeed(f)));
  let all = [];
  results.forEach((r) => {
    if (r.status === 'fulfilled') all = all.concat(r.value);
  });
  // 按链接去重
  const seen = new Set();
  all = all.filter((n) => {
    if (seen.has(n.link)) return false;
    seen.add(n.link);
    return true;
  });
  // 按时间倒序
  all.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  return all;
}

async function supplementDomesticNews() {
  const extra = await aggregateAllFeeds();
  const seen = new Set(newsCache.map((n) => n.link));
  const newItems = extra.filter((n) => !seen.has(n.link));
  if (newItems.length) {
    newsCache = [...newItems, ...newsCache];
    autoTranslateNews(newItems).then(() => { renderNews(); renderSources(); });
  }
}

async function loadLiveNews() {
  const all = await aggregateAllFeeds();
  if (!all.length) return false;
  newsCache = all.slice(0, 40);
  newsMeta = `实时聚合 · 原文直链（更新于 ${new Date().toLocaleString('zh-CN')}）`;
  autoTranslateNews(newsCache).then(() => { renderNews(); renderSources(); });
  return true;
}

export async function loadNews({ silent = false } = {}) {
  if (!silent) renderSkeletons();
  // 1) 服务端聚合 API（若已部署）
  if (await loadApiNews()) { finish(); return; }
  // 2) 每日静态数据（GitHub Actions 每日生成），优先读取，秒开且稳定
  let hasLocal = await loadLocalNews();
  if (hasLocal) { finish(); return; }
  // 3) 仅当无每日静态数据时才在线聚合原文直链 RSS（打开页面不触发实时抓取）
  try {
    const live = await aggregateAllFeeds();
    if (live.length) {
      // 合并：在线直链在前，静态补充在后，按链接去重
      const seen = new Set(live.map((n) => n.link));
      const extra = newsCache.filter((n) => !seen.has(n.link));
      newsCache = [...live, ...extra].slice(0, 40);
      newsMeta = `实时聚合 · 原文直链（更新于 ${new Date().toLocaleString('zh-CN')}）`;
      autoTranslateNews(newsCache).then(() => { renderNews(); renderSources(); });
      hasLocal = true;
    }
  } catch { /* 聚合失败则保留静态数据 */ }
  if (hasLocal) { finish(); }
  else {
    $('#mednews-list').innerHTML = '';
    renderNewsMeta();
    $('#mednews-status').innerHTML = `
      <p>暂时无法获取医讯数据，请稍后重试。</p>
      <button class="btn btn-ghost retry-btn" id="mednews-retry">重试</button>`;
    $('#mednews-retry')?.addEventListener('click', () => loadNews());
  }
  function finish() {
    renderNewsMeta();
    renderSources();
    renderNews();
    $('#mednews-status').innerHTML = '';
  }
}

export function initMednews() {
  renderCats();
  $('#mednews-cats').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (chip && chip.dataset.cat) switchCat(chip.dataset.cat);
  });
  $('#mednews-sources').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    activeSource = chip.dataset.source;
    renderSources();
    renderNews();
  });
  const onSearch = debounce(() => {
    searchText = $('#mednews-search').value;
    renderNews();
  }, 280);
  $('#mednews-search').addEventListener('input', onSearch);
  $('#mednews-list').addEventListener('click', (e) => {
    const item = e.target.closest('.news-item');
    if (!item) return;
    const link = item.dataset.link;
    const title = item.dataset.title;
    if (link && title) historyAdd({ type: 'news', title, url: link });
  });
  // 进展栏目失败重试
  $('#mednews-status').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-retry-cat]');
    if (!btn) return;
    const cat = btn.dataset.retryCat;
    progressLoaded[cat] = false;
    switchCat(cat);
  });
  $('#mednews-refresh').addEventListener('click', () => {
    if (activeCat === 'main') { loadNews(); return; }
    progressLoaded[activeCat] = false;
    progressCache[activeCat] = [];
    switchCat(activeCat);
  });
  loadNews();
}

export function onTabMednews() {
  renderCats();
  renderNewsMeta();
  renderSources();
  renderNews();
}
