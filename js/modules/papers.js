/**
 * papers.js — 文献前沿
 * 数据链路（依次尝试）：
 *   1. Netlify data-api（服务端聚合，6小时缓存，首选）
 *   2. /data/papers.json（静态兜底）
 *   3. PubMed E-utilities 浏览器直连
 */
import {
  $, $$, esc, toast, fetchWithFallback, fetchApiData, openModal, closeModal, relTime,
  translateText, isEnglish,
} from '../utils.js?v=20260921b';
import {
  store, getFields, setFields, getIFMap, setIF, historyAdd,
  getFavPapers, saveFavPaper, removeFavPaper,
} from '../storage.js?v=20260921b';

let papersCache = [];
let papersMeta = '';
let paperView = 'latest';   // 'latest'（按领域分列） | 'fav'（我的收藏）
let favCache = [];
let currentPapers = [];     // 当前视图实际渲染的文献（供事件按 index 取对象）

/* ================= 摘要结构化：研究背景 / 研究方法 / 结论 ================= */
export function structureAbstract(text) {
  const out = { background: '', methods: '', conclusion: '' };
  if (!text) return out;
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const labelRe = /^\s*((?:BACKGROUND|INTRODUCTION|OBJECTIVE|METHODS(?:\s*(?:AND|&)\s*(?:MATERIALS|METHODS|RESULTS))?|MATERIALS(?:\s*(?:AND|&)\s*METHODS)?|RESULTS|CONCLUSIONS?|CONCLUSION|KEY\s*WORDS|HIGHLIGHTS))\s*[:.]\s*/gim;
  const matches = [];
  let m;
  while ((m = labelRe.exec(text))) {
    matches.push({ label: m[1].toUpperCase().replace(/\s+/g, ' '), start: m.index, end: labelRe.lastIndex });
  }
  if (matches.length) {
    const sections = {};
    for (let i = 0; i < matches.length; i++) {
      const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
      const key = matches[i].label;
      sections[key] = (sections[key] ? `${sections[key]} ` : '') + clean(text.slice(matches[i].end, end));
    }
    out.background = sections.BACKGROUND || sections.INTRODUCTION || sections.OBJECTIVE || '';
    out.methods = sections['METHODS AND MATERIALS'] || sections['METHODS AND METHODS'] ||
      sections['METHODS AND RESULTS'] || sections['MATERIALS AND METHODS'] ||
      sections.METHODS || sections.MATERIALS || '';
    let conclusion = sections.CONCLUSIONS || sections.CONCLUSION || '';
    if (!conclusion && sections.RESULTS) {
      const sentences = sections.RESULTS.match(/[^.!?。]+[.!?。]?/g) || [sections.RESULTS];
      conclusion = clean(sentences.slice(-2).join(' ')).slice(0, 260);
      out.methods = out.methods || clean(sentences.slice(0, -2).join(' ')).slice(0, 600);
    }
    out.conclusion = conclusion;
    return out;
  }
  // 无标签：启发式切分（首句=背景，中段=方法，末句=结论）
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?。]+[.!?。]?/g) || [text];
  out.background = clean(sentences.slice(0, 2).join(' ')).slice(0, 300);
  out.conclusion = clean(sentences.slice(-2).join(' ')).slice(0, 260);
  out.methods = clean(sentences.slice(2, -2).join(' ')).slice(0, 600);
  return out;
}

/* ================= 数据加载 ================= */
function normalizePaper(raw, source) {
  return {
    pmid: raw.pmid || '',
    title: raw.title || '',
    titleCn: raw.titleCn || '',
    abstract: raw.abstract || '',
    abstractCn: raw.abstractCn || '',
    journal: raw.journal || '',
    year: raw.year || '',
    authors: Array.isArray(raw.authors) ? raw.authors.join(', ') : (raw.authors || ''),
    doi: raw.doi || '',
    link: raw.link || (raw.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${raw.pmid}/` : ''),
    sections: raw.background || raw.methods || raw.conclusion
      ? { background: raw.background || '', methods: raw.methods || '', conclusion: raw.conclusion || '' }
      : structureAbstract(raw.abstract),
    field: raw.field || '',
    source,
  };
}

function renderSkeletons() {
  $('#papers-list').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('#papers-status').innerHTML = '<div class="spin"></div>正在获取今日文献…';
}
function renderStatus(html) { $('#papers-status').innerHTML = html; }

function favKey(p) { return String(p.pmid || p.link || p.title || ''); }
function favSet() { return new Set(getFavPapers().map(favKey)); }

/** 单篇文献卡片 HTML（最新视图与收藏视图共用） */
function paperCardHtml(p, i, faved, inFavView) {
  const s = p.sections || {};
  const ifMap = getIFMap();
  const ifVal = ifMap[p.pmid];
  const fieldLabel = p.field ? `<span class="chip field-badge">${esc(p.field)}</span>` : '';
  return `
    <article class="paper-card" data-pmid="${esc(p.pmid)}" data-index="${i}">
      <div class="paper-top">
        ${fieldLabel}
        <span class="chip">${esc(p.journal || '期刊未知')}</span>
        ${p.year ? `<span class="chip">${esc(p.year)}</span>` : ''}
        <span class="if-tag">影响因子 ${esc(ifVal ?? '—')}</span>
      </div>
      <h3 class="paper-title-en">${esc(p.title)}</h3>
      ${p.titleCn ? `<p class="paper-title-cn">${esc(p.titleCn)}</p>` : ''}
      ${p.authors ? `<p class="paper-authors">${esc(p.authors)}</p>` : ''}
      <div class="paper-actions">
        <button class="expand-btn" type="button">详情 <span class="arr">›</span></button>
        ${p.link ? `<a class="paper-link" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">PubMed 原文 ↗</a>` : ''}
        <button class="fav-btn ${faved ? 'is-fav' : ''}" type="button" data-fav="${faved ? 1 : 0}">${faved ? '★ 已收藏' : '☆ 收藏'}</button>
      </div>
      <div class="paper-detail">
        ${s.background ? `<h4 data-sec="background">研究背景</h4><p>${esc(s.background)}</p>` : ''}
        ${s.methods ? `<h4 data-sec="methods">研究方法</h4><p>${esc(s.methods)}</p>` : ''}
        ${s.conclusion ? `<h4 data-sec="conclusion">结论</h4><p>${esc(s.conclusion)}</p>` : ''}
        ${p.abstract && !s.background && !s.methods && !s.conclusion ? `<h4>摘要</h4><p>${esc(p.abstract)}</p>` : ''}
        ${!p.titleCn ? `<button class="btn btn-ghost btn-sm translate-btn" type="button">翻译标题</button>` : ''}
        <div class="if-row">
          <span class="if-tag">影响因子</span>
          <input class="input" value="${esc(ifVal ?? '')}" placeholder="—" aria-label="手动标注影响因子">
          <button class="btn btn-ghost btn-sm if-save" type="button">保存</button>
        </div>
        ${inFavView ? '<div class="fav-remove-row"><button class="btn btn-ghost btn-sm fav-remove" type="button">移出收藏</button></div>' : ''}
      </div>
    </article>`;
}

function renderViewTabs() {
  const wrap = $('#paper-view-tabs');
  if (!wrap) return;
  const n = getFavPapers().length;
  wrap.innerHTML = `
    <button class="filter-chip ${paperView === 'latest' ? 'active' : ''}" data-view="latest">最新文献</button>
    <button class="filter-chip ${paperView === 'fav' ? 'active' : ''}" data-view="fav">我的收藏${n ? ` (${n})` : ''}</button>`;
}

function renderPapers() {
  const list = $('#papers-list');
  renderViewTabs();
  const favedSet = favSet();

  if (paperView === 'fav') {
    favCache = getFavPapers();
    currentPapers = favCache;
    if (!favCache.length) {
      list.innerHTML = '<div class="empty-note" style="text-align:center;padding:24px 0;">还没有收藏文献，在「最新文献」里点击 ☆收藏 即可保存到这里</div>';
      return;
    }
    list.innerHTML = `<div class="field-group"><div class="field-group-head"><span class="field-group-name">我的收藏</span><span class="field-group-count">${favCache.length}</span></div>${
      favCache.map((p, i) => paperCardHtml(p, i, true, true)).join('')
    }</div>`;
    return;
  }

  // 最新文献：按关注领域分列
  currentPapers = papersCache;
  if (!papersCache.length) { list.innerHTML = ''; return; }
  const fields = getFields();
  const groups = [];
  const pushGroup = (name, arr) => { if (arr.length) groups.push({ name, arr }); };
  fields.forEach((f) => pushGroup(f, papersCache.filter((p) => p.field === f)));
  // 未归属或不在当前领域列表内的，归入“综合推荐”
  const known = new Set(fields);
  const rest = papersCache.filter((p) => !p.field || !known.has(p.field));
  pushGroup('综合推荐', rest);

  let html = '';
  const indexOf = new Map(papersCache.map((p, k) => [p, k]));
  for (const g of groups) {
    const cards = g.arr.map((p) => paperCardHtml(p, indexOf.get(p), favedSet.has(favKey(p)), false)).join('');
    html += `<div class="field-group">
      <div class="field-group-head"><span class="field-group-name">${esc(g.name)}</span><span class="field-group-count">${g.arr.length}</span></div>
      ${cards}
    </div>`;
  }
  list.innerHTML = html;
}

function renderPapersMeta() {
  $('#papers-meta').textContent = papersMeta ? `数据源：${papersMeta}` : '';
}

/* ---------- 数据源 0：Netlify data-api（首选，服务端聚合） ---------- */
async function loadApiPapers() {
  const data = await fetchApiData('papers');
  if (data && Array.isArray(data.papers) && data.papers.length) {
    papersCache = data.papers.map((p) => normalizePaper(p, 'PubMed 每日更新'));
    papersMeta = `PubMed 每日更新（更新于 ${new Date(data.lastUpdated).toLocaleString('zh-CN')}）`;
    return true;
  }
  return false;
}

/* ---------- 数据源 1：本地静态 JSON ---------- */
async function loadLocalPapers() {
  try {
    const data = await fetchWithFallback([`/data/papers.json?v=${Date.now()}`]);
    if (data && Array.isArray(data.items) && data.items.length) {
      papersCache = data.items.map((p) => normalizePaper(p, '每日数据'));
      papersMeta = data.lastUpdated
        ? `GitHub Actions 每日数据（更新于 ${new Date(data.lastUpdated).toLocaleString('zh-CN')}）`
        : 'GitHub Actions 每日数据';
      return true;
    }
  } catch { /* 未部署或数据为空则走下一级 */ }
  return false;
}

/* ---------- 数据源 2：Pages Function 代理 PubMed ---------- */
async function loadProxyPapers() {
  const fields = getFields();
  const url = `/api/proxy?target=pubmed&terms=${encodeURIComponent(fields.join(','))}&retmax=10&_=${Date.now()}`;
  try {
    const data = await fetchWithFallback([url]);
    if (data && Array.isArray(data.items) && data.items.length) {
      papersCache = data.items.map((p) => normalizePaper(p, 'PubMed 实时'));
      papersMeta = `PubMed 实时代理（更新于 ${new Date(data.lastUpdated || Date.now()).toLocaleString('zh-CN')}）`;
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

/* ---------- 数据源 3：PubMed E-utilities 浏览器直连（NCBI 支持 CORS） ---------- */
const decodeEntities = (s = '') => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const stripXmlTags = (s = '') => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const xmlTag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};
const xmlClean = (block, name) => stripXmlTags(xmlTag(block, name));

function parsePubmedXml(xml) {
  const items = [];
  for (const b of xml.split('<PubmedArticle>').slice(1)) {
    const pmid = xmlClean(b, 'PMID');
    if (!pmid) continue;
    const absParts = [];
    const absRe = /<AbstractText(?: Label="([^"]*)")?[^>]*>([\s\S]*?)<\/AbstractText>/gi;
    let am;
    while ((am = absRe.exec(b))) absParts.push((am[1] ? `${am[1]}: ` : '') + stripXmlTags(am[2]));
    const abstract = absParts.join(' ').replace(/\s+/g, ' ').trim();
    const authors = [];
    const auRe = /<Author[^>]*>([\s\S]*?)<\/Author>/gi;
    let am2;
    while ((am2 = auRe.exec(b))) {
      const ln = xmlClean(am2[1], 'LastName');
      const fn = xmlClean(am2[1], 'ForeName');
      if (ln) authors.push(fn ? `${fn} ${ln}` : ln);
    }
    if (!authors.length) {
      const coll = xmlClean(b, 'CollectiveName');
      if (coll) authors.push(coll);
    }
    const journal = xmlClean(b.match(/<Journal>([\s\S]*?)<\/Journal>/)?.[1] || b, 'Title');
    const yearM = b.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/) || b.match(/<MedlineDate>(\d{4})/);
    const doiM = b.match(/<ELocationID[^>]*EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/i);
    items.push({
      pmid, title: xmlClean(b, 'ArticleTitle'), abstract, journal,
      year: yearM ? yearM[1] : '', authors,
      doi: doiM ? stripXmlTags(doiM[1]) : '',
      link: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      sections: structureAbstract(abstract),
    });
  }
  return items;
}

async function fetchPubmedLive() {
  const fields = getFields();
  const idField = {};
  const order = [];
  // 每个关注领域独立检索，记录 id → 领域归属（每领域最多 5 篇，最多 4 个领域）
  for (const f of fields.slice(0, 4)) {
    try {
      const data = await fetchWithFallback([
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(f)}&retmax=5&sort=date&retmode=json`,
      ]);
      (data.esearchresult?.idlist || []).forEach((id) => {
        if (!(id in idField)) { idField[id] = f; order.push(id); }
      });
    } catch { /* 跳过该领域 */ }
  }
  if (!order.length) return null;
  const idList = order.slice(0, 20);
  // efetch 返回 XML 文本，需用文本抓取而非 JSON 解析
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let xml = '';
  try {
    const res = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${idList.join(',')}&retmode=xml`,
      { signal: ctrl.signal }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch { return null; } finally {
    clearTimeout(timer);
  }
  const parsed = parsePubmedXml(xml);
  const byId = {};
  parsed.forEach((p) => { byId[p.pmid] = p; });
  // 按领域检索顺序输出，并标注 field
  const items = idList.map((id) => byId[id]).filter(Boolean).map((p) =>
    normalizePaper({ ...p, field: idField[p.pmid] || '' }, 'PubMed 实时（直连）'));
  return items.length ? items : null;
}

async function loadPubmedDirect() {
  const items = await fetchPubmedLive();
  if (!items) return false;
  papersCache = items;
  papersMeta = 'PubMed E-utilities 直连（更新于 ' + new Date().toLocaleString('zh-CN') + '）';
  return true;
}

export async function loadPapers({ silent = false } = {}) {
  if (!silent) renderSkeletons();
  // 1) 服务端聚合 API（若已部署且新鲜）
  if (await loadApiPapers()) { finish(); return; }
  // 2) 每日静态数据（GitHub Actions 每日生成），优先读取，秒开且稳定
  let hasData = await loadLocalPapers();
  if (hasData) { finish(); return; }
  // 3) 仅当无每日静态数据时才实时聚合 PubMed（打开页面不触发实时抓取）
  try {
    const live = await fetchPubmedLive();
    if (live && live.length) {
      papersCache = live;
      papersMeta = 'PubMed E-utilities 实时直连（更新于 ' + new Date().toLocaleString('zh-CN') + '）';
      hasData = true;
    }
  } catch { /* 失败保留静态数据 */ }
  if (hasData) { finish(); }
  else {
    $('#papers-list').innerHTML = '';
    renderPapersMeta();
    renderStatus(`
      <p>暂时无法获取文献数据，请稍后重试。</p>
      <button class="btn btn-ghost retry-btn" id="papers-retry">重试</button>
    `);
    $('#papers-retry')?.addEventListener('click', () => loadPapers());
  }
  function finish() {
    renderPapersMeta();
    renderPapers();
    renderStatus('');
  }
}

/* ================= 关注领域管理 ================= */
function renderFieldChips() {
  const wrap = $('#field-chips');
  const fields = getFields();
  wrap.innerHTML = fields.map((f) => `
    <span class="field-chip">${esc(f)}<button type="button" data-field="${esc(f)}" aria-label="删除 ${esc(f)}">✕</button></span>
  `).join('') || '<span class="empty-note">尚未添加关注领域</span>';
  $$('#field-chips .field-chip button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = getFields().filter((f) => f !== btn.dataset.field);
      setFields(next);
      renderFieldChips();
      toast('已删除领域，下拉刷新文献');
    });
  });
}

function openFieldModal() {
  openModal(`
    <h3>管理关注领域</h3>
    <div class="m-field">
      <label class="field">添加关键词（如 cardiology / immunotherapy / Hepatitis / Liver cancer）</label>
      <form class="task-form" id="field-add-form" style="margin-top:8px;">
        <input class="input" id="field-input" placeholder="输入英文关键词" autocomplete="off">
        <button class="btn btn-primary" type="submit">添加</button>
      </form>
    </div>
    <div class="field-chips" id="modal-field-chips"></div>
    <div class="m-actions">
      <button class="btn btn-ghost" id="field-done">完成</button>
    </div>
  `, {
    onMount: () => {
      const chipsWrap = $('#modal-field-chips');
      const render = () => {
        chipsWrap.innerHTML = getFields().map((f) =>
          `<span class="field-chip">${esc(f)}<button type="button" data-field="${esc(f)}">✕</button></span>`).join('')
          || '<span class="empty-note">暂无领域</span>';
        $$('#modal-field-chips .field-chip button').forEach((b) => {
          b.addEventListener('click', () => {
            setFields(getFields().filter((f) => f !== b.dataset.field));
            render();
          });
        });
      };
      render();
      $('#field-add-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = $('#field-input').value.trim();
        if (!v) return;
        setFields([...getFields(), v]);
        $('#field-input').value = '';
        render();
      });
      $('#field-done').addEventListener('click', () => {
        closeModal();
        renderFieldChips();
        toast('领域已更新');
      });
    },
  });
}

/* ================= 自动翻译文献详情 ================= */
async function autoTranslatePaper(p, card) {
  const detail = card.querySelector('.paper-detail');
  if (!detail) return;

  // 翻译标题（如果还没有中文标题）
  if (!p.titleCn && isEnglish(p.title)) {
    const cn = await translateText(p.title);
    if (cn) {
      p.titleCn = cn;
      const titleEl = card.querySelector('.paper-title-cn');
      if (titleEl) titleEl.textContent = cn;
      else card.querySelector('.paper-title-en')?.insertAdjacentHTML('afterend', `<p class="paper-title-cn">${esc(cn)}</p>`);
      // 自动翻译成功后移除冗余的“翻译标题”按钮
      card.querySelector('.translate-btn')?.remove();
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // 翻译各段落（按 h4 的 data-sec 匹配，避免依赖中文小标题文案）
  const s = p.sections || {};
  const sections = [
    { key: 'background' },
    { key: 'methods' },
    { key: 'conclusion' },
  ];

  for (const sec of sections) {
    const en = s[sec.key];
    if (!en || !isEnglish(en)) continue;
    const h4 = detail.querySelector(`h4[data-sec="${sec.key}"]`);
    const targetP = h4 ? h4.nextElementSibling : null;
    if (!targetP) continue;
    // 已有译文或正在翻译则跳过
    if (targetP.dataset.translated) continue;
    if (targetP.nextElementSibling && targetP.nextElementSibling.classList.contains('cn-translation')) continue;
    targetP.dataset.translated = '1';

    targetP.insertAdjacentHTML('afterend', `<p class="cn-translation" data-key="${sec.key}">翻译中…</p>`);
    const cnP = targetP.nextElementSibling;
    let cn = '';
    try {
      cn = await translateText(en.slice(0, 900));
    } catch { cn = ''; }
    if (cn) {
      cnP.textContent = cn;
      cnP.dataset.translated = '1';
    } else {
      // 失败时允许稍后重试
      targetP.dataset.translated = '';
      cnP.textContent = '翻译失败，可再次点开重试';
    }
    // 逐段翻译间隔，降低翻译接口限流概率
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ================= 手动翻译标题（MyMemory，国内可达） ================= */
async function translateTitle(p) {
  try {
    return await translateText(p.title.slice(0, 480));
  } catch { return ''; }
}

function bindPapersEvents() {
  const list = $('#papers-list');
  list.addEventListener('click', async (e) => {
    const card = e.target.closest('.paper-card');
    if (!card) return;
    const p = currentPapers[Number(card.dataset.index)];
    if (!p) return;

    // 收藏 / 取消收藏
    const favBtn = e.target.closest('.fav-btn');
    if (favBtn) {
      const key = favKey(p);
      if (favBtn.dataset.fav === '1') {
        removeFavPaper(key);
        if (paperView === 'fav') { renderPapers(); toast('已移出收藏'); }
        else {
          favBtn.dataset.fav = '0';
          favBtn.classList.remove('is-fav');
          favBtn.textContent = '☆ 收藏';
          renderViewTabs();
          toast('已取消收藏');
        }
      } else {
        saveFavPaper(p);
        favBtn.dataset.fav = '1';
        favBtn.classList.add('is-fav');
        favBtn.textContent = '★ 已收藏';
        renderViewTabs();
        toast('已收藏文献');
      }
      return;
    }
    // 收藏视图：详情区内“移出收藏”
    if (e.target.closest('.fav-remove')) {
      removeFavPaper(favKey(p));
      renderPapers();
      toast('已移出收藏');
      return;
    }

    if (e.target.closest('.expand-btn')) {
      const wasOpen = card.classList.contains('open');
      card.classList.toggle('open');
      if (!wasOpen && (p.pmid || p.link)) {
        historyAdd({ type: 'paper', title: p.title, url: p.link });
        // 自动翻译标题和摘要段落
        autoTranslatePaper(p, card);
      }
      return;
    }
    if (e.target.closest('.translate-btn')) {
      const btn = e.target.closest('.translate-btn');
      btn.textContent = '翻译中…';
      btn.disabled = true;
      const cn = await translateTitle(p);
      if (cn) {
        p.titleCn = cn;
        const titleEl = card.querySelector('.paper-title-cn');
        if (titleEl) titleEl.textContent = cn;
        else card.querySelector('.paper-title-en').insertAdjacentHTML('afterend', `<p class="paper-title-cn">${esc(cn)}</p>`);
        btn.remove();
        toast('已翻译');
      } else {
        btn.textContent = '翻译失败，重试';
        btn.disabled = false;
      }
      return;
    }
    if (e.target.closest('.if-save')) {
      const input = card.querySelector('.if-row .input');
      const val = input.value.trim();
      setIF(p.pmid, val);
      card.querySelector('.if-tag').textContent = `影响因子 ${val || '—'}`;
      toast('已保存标注');
      return;
    }
  });
}

/* ================= 子栏目切换（最新文献 / 我的收藏） ================= */
function bindViewTabs() {
  $('#paper-view-tabs').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    paperView = chip.dataset.view;
    $('#papers-status').innerHTML = '';
    renderPapers();
  });
}

/* ================= 模块入口 ================= */
export function initPapers() {
  renderFieldChips();
  bindViewTabs();
  bindPapersEvents();
  $('#field-manage').addEventListener('click', openFieldModal);
  $('#papers-refresh').addEventListener('click', () => loadPapers());
  loadPapers();
}
export function onTabPapers() {
  renderPapersMeta();
  renderPapers();
}
