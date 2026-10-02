/**
 * space.js — 个人空间：临床病例笔记（富文本）、实验手记、书单影视
 */
import {
  $, $$, esc, toast, dateKey, uid, openModal, closeModal, firstSentence, fetchViaProxy, dailyPick,
} from '../utils.js?v=20261003a';
import {
  store, getNotes, saveNote, deleteNote,
  getLabs, saveLab, deleteLab,
  getBooks, saveBook, deleteBook,
} from '../storage.js?v=20261003a';

/* ================= 豆瓣书影音推荐（自动生成，点击直达豆瓣详情页） ================= */
let recommendCache = [];
const RSSHUB_INSTANCES = ['https://rsshub.rssforever.com', 'https://rsshub.app'];

/** 解析单条 RSS 文本为推荐条目 */
function parseDoubanXml(text, type, limit) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  const get = (block, tag) => {
    const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!mm) return '';
    return mm[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  };
  while ((m = re.exec(text))) {
    const block = m[1];
    const name = get(block, 'title');
    const link = get(block, 'link');
    const desc = get(block, 'description');
    if (!name || !/^https?:\/\/(movie|book)\.douban\.com\//i.test(link)) continue;
    const ratingM = desc.match(/([\d.]+)\s*分/);
    const rating = ratingM ? ratingM[1] : '';
    // 简介取“影片信息：/出版社简介”之后的内容，去掉评分/标签噪声
    let comment = desc.replace(/^.*?影片信息[:：]/, '').replace(/标题[:：].*?标签[:：][^影]*?(?=影片信息|$)/, '').trim();
    comment = comment || desc.replace(/标题[:：].*?分/, '').trim();
    if (comment.length > 60) comment = comment.slice(0, 60) + '…';
    items.push({ name, type, rating, comment: comment || '豆瓣推荐', doubanLink: link, source: link });
    if (items.length >= limit) break;
  }
  return items;
}

/** 经多通道代理抓取一个豆瓣 RSSHub 路由（多实例容错） */
async function fetchDoubanRoute(route, type, limit = 8) {
  for (const inst of RSSHUB_INSTANCES) {
    try {
      const text = await fetchViaProxy(inst + route, { timeout: 14000 });
      const items = parseDoubanXml(text, type, limit);
      if (items.length) return items;
    } catch { /* 尝试下一实例 */ }
  }
  return [];
}

/** 自动生成：豆瓣电影口碑榜 + 豆瓣新书速递 */
async function fetchDoubanRecommend() {
  const [movies, books] = await Promise.all([
    fetchDoubanRoute('/douban/movie/weekly', '电影', 8),
    fetchDoubanRoute('/douban/book/latest', '书籍', 8),
  ]);
  return [...movies, ...books];
}

/** 内置经典推荐（兜底） */
const FALLBACK_BOOKS = [
  { name: '《内科学》第9版', type: '书籍', rating: '', comment: '医学经典教材', doubanLink: 'https://search.douban.com/book/subject_search?search_text=内科学 第9版' },
  { name: '《格氏解剖学》', type: '书籍', rating: '', comment: '解剖学权威参考书', doubanLink: 'https://search.douban.com/book/subject_search?search_text=格氏解剖学' },
  { name: '《我不是药神》', type: '电影', rating: '9.0', comment: '医疗题材高分电影', doubanLink: 'https://search.douban.com/movie/subject_search?search_text=我不是药神' },
  { name: '《工作细胞》', type: '电影', rating: '8.9', comment: '医学科普动画', doubanLink: 'https://search.douban.com/movie/subject_search?search_text=工作细胞' },
  { name: '《医学的真相》', type: '书籍', rating: '', comment: '阿图·葛文德 医学人文', doubanLink: 'https://search.douban.com/book/subject_search?search_text=医学的真相' },
  { name: '《清单革命》', type: '书籍', rating: '', comment: '医疗安全与清单管理', doubanLink: 'https://search.douban.com/book/subject_search?search_text=清单革命' },
  { name: '《良医》The Good Doctor', type: '电影', rating: '', comment: '医疗题材美剧', doubanLink: 'https://search.douban.com/movie/subject_search?search_text=良医' },
];

async function loadRecommend() {
  const wrap = $('#book-recommend');
  if (!wrap) return;
  wrap.innerHTML = '<div class="spin" style="margin:20px auto;"></div>';
  try {
    // 优先读每日静态数据（服务端生成，同源、秒开、无 CORS）
    const local = await loadLocalDouban();
    if (local && local.length) {
      recommendCache = local.slice(0, 16);
      renderRecommend();
      return;
    }
  } catch { /* 无每日数据则走实时抓取兜底 */ }
  try {
    const online = await fetchDoubanRecommend();
    recommendCache = online.length ? online.slice(0, 16) : FALLBACK_BOOKS;
  } catch {
    recommendCache = FALLBACK_BOOKS;
  }
  renderRecommend();
}

/** 读取每日静态豆瓣推荐 data/douban.json（相对路径，适配子路径部署） */
async function loadLocalDouban() {
  const res = await fetch(`data/douban.json?v=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.items) || !data.items.length) return [];
  return data.items;
}

function renderRecommend() {
  const wrap = $('#book-recommend');
  if (!wrap) return;
  if (!recommendCache.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = recommendCache.map((b, i) => `
    <a class="book-item recommend-item" href="${esc(b.doubanLink)}" target="_blank" rel="noopener noreferrer" data-index="${i}">
      <div style="flex:1;min-width:0;">
        <div class="book-name">${esc(b.name)}${b.rating ? ` <span style="color:var(--accent,#4A90D9);font-size:0.85em;">★${esc(b.rating)}</span>` : ''}</div>
        <div class="book-meta">
          <span class="chip">${esc(b.type)}</span>
          <span style="opacity:0.6;">豆瓣详情 ↗</span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm book-add-rec" type="button" data-index="${i}">+ 收藏</button>
    </a>`).join('');
}

/* ================= 子页切换 ================= */
function initSpaceTabs() {
  $('#space-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.space-tab');
    if (!btn) return;
    $$('#space-tabs .space-tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.space-pane').forEach((p) => p.classList.toggle('active', p.id === `space-${btn.dataset.space}`));
  });
}

/* ================= 临床病例笔记 ================= */
function renderNotes() {
  const list = getNotes();
  const grid = $('#notes-grid');
  if (!list.length) {
    grid.innerHTML = '';
    $('#notes-status').innerHTML = '<div class="empty-note" style="text-align:center;padding:20px 0;">还没有病例笔记，点击右上角「新建笔记」开始记录</div>';
    return;
  }
  $('#notes-status').innerHTML = '';
  grid.innerHTML = list.map((n) => `
    <article class="note-card" data-id="${n.id}">
      <div class="note-head">
        <h3>${esc(n.title || '未命名笔记')}</h3>
        <span class="note-date">${esc(n.date || '')}</span>
      </div>
      ${n.tags ? `<div class="note-tags">${n.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="note-body">${n.html || ''}</div>
      <div class="note-actions">
        <button class="btn btn-ghost btn-sm note-edit" type="button">编辑</button>
        <button class="btn btn-ghost btn-sm note-del" type="button">删除</button>
      </div>
    </article>`).join('');
}

function openNoteEditor(note = null) {
  const n = note || { id: '', title: '', tags: [], date: dateKey(), html: '' };
  openModal(`
    <h3>${n.id ? '编辑病例笔记' : '新建病例笔记'}</h3>
    <div class="m-field">
      <label class="field">标题
        <input class="input" id="note-title" maxlength="80" value="${esc(n.title)}" placeholder="如：发热伴皮疹病例">
      </label>
    </div>
    <div class="m-field">
      <label class="field">标签（用逗号分隔）
        <input class="input" id="note-tags" value="${esc(n.tags.join(', '))}" placeholder="如：感染科, 疑难病例">
      </label>
    </div>
    <div class="m-field">
      <label class="field">日期 <input class="input" id="note-date" type="date" value="${esc(n.date)}"></label>
    </div>
    <div class="m-field">
      <div class="editor-toolbar" aria-label="格式工具">
        <button type="button" data-cmd="bold">B</button>
        <button type="button" data-cmd="italic">I</button>
        <button type="button" data-cmd="underline">U</button>
        <button type="button" data-cmd="formatBlock" data-val="h2">H2</button>
        <button type="button" data-cmd="insertUnorderedList">• 列表</button>
        <button type="button" data-cmd="insertOrderedList">1. 列表</button>
      </div>
      <div class="contenteditable" id="note-body" contenteditable="true">${n.html || ''}</div>
    </div>
    <div class="m-actions">
      <button class="btn btn-primary" id="note-save">保存</button>
      <button class="btn btn-ghost" id="note-cancel">取消</button>
    </div>
  `, {
    onMount: () => {
      const body = $('#note-body');
      $$('#modal-root .editor-toolbar button').forEach((b) => {
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          try {
            document.execCommand(b.dataset.cmd, false, b.dataset.val || null);
          } catch { /* execCommand 不可用时忽略 */ }
          body.focus();
        });
      });
      $('#note-save').addEventListener('click', () => {
        const title = $('#note-title').value.trim();
        const html = body.innerHTML.trim();
        if (!title && !html) { toast('标题或内容不能为空'); return; }
        saveNote({
          id: n.id,
          title: title || '未命名笔记',
          tags: $('#note-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          date: $('#note-date').value || dateKey(),
          html,
          updatedAt: Date.now(),
        });
        closeModal();
        renderNotes();
        toast(n.id ? '笔记已更新' : '笔记已保存');
      });
      $('#note-cancel').addEventListener('click', closeModal);
    },
  });
}

function initNotes() {
  renderNotes();
  $('#note-new').addEventListener('click', () => openNoteEditor());
  $('#notes-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.note-card');
    if (!card) return;
    const n = getNotes().find((x) => x.id === card.dataset.id);
    if (!n) return;
    if (e.target.closest('.note-edit')) openNoteEditor(n);
    else if (e.target.closest('.note-del')) {
      deleteNote(n.id);
      renderNotes();
      toast('笔记已删除');
    }
  });
}

/* ================= 实验手记 ================= */
function renderLabs() {
  const list = getLabs();
  const wrap = $('#lab-list');
  if (!list.length) {
    wrap.innerHTML = '';
    $('#labs-status').innerHTML = '<div class="empty-note" style="text-align:center;padding:20px 0;">还没有实验手记</div>';
    return;
  }
  $('#labs-status').innerHTML = '';
  wrap.innerHTML = list.map((l) => `
    <div class="lab-record" data-id="${l.id}">
      <div class="note-head">
        <h3>${esc(l.name)}</h3>
        <span class="note-date">${esc(l.date || '')}</span>
      </div>
      ${l.purpose ? `<div class="lab-kv"><b>目的：</b>${esc(l.purpose)}</div>` : ''}
      ${l.steps ? `<div class="lab-kv"><b>步骤：</b>${esc(l.steps)}</div>` : ''}
      ${l.results ? `<div class="lab-kv"><b>结果：</b>${esc(l.results)}</div>` : ''}
      ${l.remarks ? `<div class="lab-kv"><b>备注：</b>${esc(l.remarks)}</div>` : ''}
      <div class="note-actions">
        <button class="btn btn-ghost btn-sm lab-del" type="button">删除</button>
      </div>
    </div>`).join('');
}

function initLabs() {
  const form = $('#lab-form');
  $('#lab-toggle').addEventListener('click', () => {
    const show = form.hidden;
    form.hidden = !show;
    $('#lab-toggle').textContent = show ? '收起表单' : '+ 新建实验手记';
    if (show) form.reset();
  });
  $('#lab-cancel').addEventListener('click', () => {
    form.hidden = true;
    $('#lab-toggle').textContent = '+ 新建实验手记';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim();
    if (!name) { toast('请填写实验名称'); return; }
    saveLab({
      id: '',
      name,
      date: fd.get('date') || dateKey(),
      purpose: (fd.get('purpose') || '').trim(),
      steps: (fd.get('steps') || '').trim(),
      results: (fd.get('results') || '').trim(),
      remarks: (fd.get('remarks') || '').trim(),
      createdAt: Date.now(),
    });
    form.reset();
    form.hidden = true;
    $('#lab-toggle').textContent = '+ 新建实验手记';
    renderLabs();
    toast('实验手记已保存');
  });
  $('#lab-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.lab-del');
    if (!btn) return;
    const rec = btn.closest('.lab-record');
    deleteLab(rec.dataset.id);
    renderLabs();
    toast('已删除');
  });
  renderLabs();
}

/* ================= 书单 / 影视 ================= */
let bookSort = 'latest';
let bookFilter = 'all';

function renderBooks() {
  let list = [...getBooks()];
  if (bookFilter !== 'all') list = list.filter((b) => b.type === bookFilter);
  if (bookSort === 'rating') list.sort((a, b) => (b.rating || 0) - (a.rating || 0) || b.createdAt - a.createdAt);
  else list.sort((a, b) => b.createdAt - a.createdAt);

  const wrap = $('#book-list');
  if (!list.length) {
    wrap.innerHTML = '';
    $('#books-status').innerHTML = '<div class="empty-note" style="text-align:center;padding:12px 0;">暂无收藏，可在下方豆瓣推荐中点「+ 收藏」</div>';
    return;
  }
  $('#books-status').innerHTML = '';
  const stars = (n) => '★★★★★'.slice(0, n || 0) || '—';
  wrap.innerHTML = list.map((b) => `
    <div class="book-item" data-id="${b.id}">
      <div style="flex:1;min-width:0;">
        <div class="book-name">${esc(b.name)}</div>
        ${b.comment ? `<div class="book-comment">${esc(b.comment)}</div>` : ''}
        <div class="book-meta">
          <span class="chip">${esc(b.type || '其他')}</span>
          <span class="stars">${stars(Number(b.rating))}</span>
          <span>${new Date(b.createdAt).toLocaleDateString('zh-CN')}</span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm book-del" type="button">删除</button>
    </div>`).join('');
}

function initBooks() {
  // 书影音已改为全自动推荐（豆瓣），不再提供手动新增表单
  $('#book-sort').addEventListener('change', (e) => { bookSort = e.target.value; renderBooks(); });
  $('#book-filter').addEventListener('change', (e) => { bookFilter = e.target.value; renderBooks(); });
  $('#book-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.book-del');
    if (!btn) return;
    const item = btn.closest('.book-item');
    deleteBook(item.dataset.id);
    renderBooks();
    toast('已移除');
  });
  // 推荐区域：收藏按钮
  $('#book-recommend').addEventListener('click', (e) => {
    const btn = e.target.closest('.book-add-rec');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const rec = recommendCache[Number(btn.dataset.index)];
    if (!rec) return;
    saveBook({ name: rec.name, type: rec.type, rating: 0, comment: rec.comment || '' });
    renderBooks();
    toast('已收藏到书单列');
  });
  renderBooks();
  loadRecommend();
}

/* ================= 文学经典（每日推荐：经典诗词 + 近现代散文） ================= */
let litData = null;
let litSalt = 0;

const FALLBACK_LIT = {
  poems: [
    { title: '登鹳雀楼', dynasty: '唐', url: 'https://www.gushiwen.cn/shiwenv_c90ff9ea5a71.aspx' },
    { title: '相思', dynasty: '唐', url: 'https://www.gushiwen.cn/shiwenv_f324eea45183.aspx' },
    { title: '鹿柴', dynasty: '唐', url: 'https://www.gushiwen.cn/shiwenv_e9b1a8b4def0.aspx' },
    { title: '竹里馆', dynasty: '唐', url: 'https://www.gushiwen.cn/shiwenv_4809b5e7a16a.aspx' },
    { title: '问刘十九', dynasty: '唐', url: 'https://www.gushiwen.cn/shiwenv_d09fef17613b.aspx' },
  ],
  essays: [
    { title: '背影', author: '朱自清', url: 'https://zh.wikisource.org/wiki/%E8%83%8C%E5%BD%B1' },
    { title: '荷塘月色', author: '朱自清', url: 'https://zh.wikisource.org/wiki/%E8%8D%B7%E5%A1%98%E6%9C%88%E8%89%B2' },
    { title: '匆匆', author: '朱自清', url: 'https://zh.wikisource.org/wiki/%E5%8C%86%E5%8C%86' },
    { title: '从百草园到三味书屋', author: '鲁迅', url: 'https://zh.wikisource.org/wiki/%E4%BB%8E%E7%99%BE%E8%8D%89%E5%9B%AD%E5%88%B0%E4%B8%89%E5%91%B3%E4%B9%A6%E5%B1%8B' },
  ],
};

async function loadLiterature() {
  const wrap = $('#lit-status');
  if (wrap) wrap.innerHTML = '<div class="spin" style="margin:16px auto;"></div>';
  try {
    const data = await fetchLitJson();
    litData = (data && (data.poems?.length || data.essays?.length)) ? data : FALLBACK_LIT;
  } catch { litData = FALLBACK_LIT; }
  renderLiterature();
}
async function fetchLitJson() {
  // 静态数据随站点部署（每日构建刷新），直接同源读取
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`data/literature.json?v=${new Date().toDateString()}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function litItemHtml(it, kind) {
  const tag = kind === 'poem'
    ? `<span class="chip">${esc(it.dynasty || '诗词')}</span>`
    : `<span class="chip">${esc(it.author || '散文')}</span>`;
  return `
    <a class="lit-item" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">
      <div class="lit-name">${esc(it.title)}</div>
      <div class="lit-meta">${tag}<span style="opacity:0.6;">阅读原文 ↗</span></div>
    </a>`;
}

function renderLiterature() {
  if (!litData) return;
  const poemBox = $('#lit-poem-list');
  const essayBox = $('#lit-essay-list');
  const status = $('#lit-status');
  if (status) status.innerHTML = '';
  const poems = dailyPick(litData.poems || FALLBACK_LIT.poems, 10, 'poem' + litSalt);
  const essays = dailyPick(litData.essays || FALLBACK_LIT.essays, 10, 'essay' + litSalt);
  if (poemBox) poemBox.innerHTML = poems.map((p) => litItemHtml(p, 'poem')).join('');
  if (essayBox) essayBox.innerHTML = essays.map((e) => litItemHtml(e, 'essay')).join('');
}

function initLiterature() {
  $('#lit-shuffle')?.addEventListener('click', () => {
    litSalt += 1;
    renderLiterature();
  });
  loadLiterature();
}

/* ================= 模块入口 ================= */
export function initSpace() {
  initSpaceTabs();
  initNotes();
  initLabs();
  initBooks();
  initLiterature();
}
export function onTabSpace() {
  renderNotes();
  renderLabs();
  renderBooks();
  renderLiterature();
}
