/**
 * storage.js — localStorage 数据层（所有用户数据统一命名空间）
 * 键结构：mednotes:<key>
 */
import { toast, uid } from './utils.js';

const PREFIX = 'mednotes:';
export { PREFIX };

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      toast('本地存储失败（可能处于隐私模式或已满）');
      return false;
    }
  },
  del(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  },
};

/* ---------------- 任务（按日期分组） ---------------- */
export function getTasks(dateKey) {
  const all = store.get('tasks', {});
  return all[dateKey] || [];
}
export function setTasks(dateKey, list) {
  const all = store.get('tasks', {});
  all[dateKey] = list;
  store.set('tasks', all);
}
export function addTask(dateKey, text) {
  const list = getTasks(dateKey);
  list.push({ id: uid(), text, done: false, createdAt: Date.now() });
  setTasks(dateKey, list);
  return list;
}
export function updateTask(dateKey, id, patch) {
  const list = getTasks(dateKey).map((t) => (t.id === id ? { ...t, ...patch } : t));
  setTasks(dateKey, list);
  return list;
}
export function removeTask(dateKey, id) {
  const list = getTasks(dateKey).filter((t) => t.id !== id);
  setTasks(dateKey, list);
  return list;
}

/* ---------------- 番茄钟记录（按日期累计分钟数） ---------------- */
export function getPomoMinutes(dateKey) {
  return store.get('pomo', {})[dateKey] || 0;
}
export function addPomoMinutes(dateKey, minutes) {
  const all = store.get('pomo', {});
  all[dateKey] = (all[dateKey] || 0) + minutes;
  store.set('pomo', all);
}

/* ---------------- 浏览历史 ---------------- */
export function historyList() {
  return store.get('history', []);
}
export function historyAdd(item) {
  const list = historyList();
  list.unshift({
    id: uid(),
    type: item.type,          // 'paper' | 'news' | 'brief'
    title: item.title || '',
    url: item.url || '',
    time: Date.now(),
  });
  store.set('history', list.slice(0, 100));
  window.dispatchEvent(new CustomEvent('history:changed'));
}
export function historyClear() {
  store.del('history');
  window.dispatchEvent(new CustomEvent('history:changed'));
}

/* ---------------- 关注领域（文献） ---------------- */
export const DEFAULT_FIELDS = ['cardiology', 'immunotherapy', 'Hepatitis', 'Liver cancer'];
const FIELDS_VERSION = '20260921-fields';
export function getFields() {
  // 版本迁移：默认关注领域更新后，各设备首次打开自动应用新默认（用户随后可自行增删）
  if (store.get('fieldsVersion') !== FIELDS_VERSION) {
    store.set('fieldsVersion', FIELDS_VERSION);
    store.set('fields', [...DEFAULT_FIELDS]);
    return [...DEFAULT_FIELDS];
  }
  const f = store.get('fields', DEFAULT_FIELDS);
  return Array.isArray(f) && f.length ? f : [...DEFAULT_FIELDS];
}
export function setFields(list) {
  store.set('fieldsVersion', FIELDS_VERSION);
  store.set('fields', [...new Set(list.map((s) => s.trim()).filter(Boolean))]);
}

/* ---------------- 云端同步：纳入同步的用户数据键白名单 ----------------
   lastTab 等纯本机 UI 状态、同步引擎自身的 synccode/syncmeta 不同步。 */
export const SYNCED_KEYS = [
  'tasks', 'pomo', 'history', 'fields', 'fieldsVersion',
  'ifmap', 'favpapers', 'notes', 'labs', 'books', 'pomoSettings',
];

/* ---------------- 期刊影响因子手动标注（key: pmid） ---------------- */
export function getIFMap() {
  return store.get('ifmap', {});
}
export function setIF(pmid, value) {
  const m = getIFMap();
  m[pmid] = value;
  store.set('ifmap', m);
}

/* ---------------- 文献收藏（key: pmid，无 pmid 时用 link） ---------------- */
export function getFavPapers() {
  return store.get('favpapers', []);
}
function favKeyOf(p) {
  return String(p.pmid || p.link || p.title || '');
}
export function isFavPaper(p) {
  const k = favKeyOf(p);
  if (!k) return false;
  return getFavPapers().some((x) => favKeyOf(x) === k);
}
/** 手动收藏：标题 + 标签 + 链接（与文献前沿 ☆收藏 存入同一列表） */
export function addManualPaperFav(paper) {
  const list = getFavPapers();
  const k = String(paper.link || paper.title || '');
  if (!k) return false;
  if (list.some((x) => favKeyOf(x) === k)) return false;
  list.unshift({
    title: paper.title || '',
    tags: Array.isArray(paper.tags) ? paper.tags : [],
    link: paper.link || '',
    manual: true,
    favAt: Date.now(),
  });
  store.set('favpapers', list);
  return true;
}
export function saveFavPaper(paper) {
  const list = getFavPapers();
  const k = favKeyOf(paper);
  if (k && !list.some((x) => favKeyOf(x) === k)) {
    list.unshift({ ...paper, favAt: Date.now() });
    store.set('favpapers', list);
  }
  return list;
}
export function removeFavPaper(key) {
  store.set('favpapers', getFavPapers().filter((x) => favKeyOf(x) !== String(key)));
}

/* ---------------- 病例笔记 ---------------- */
export function getNotes() {
  return store.get('notes', []);
}
export function saveNote(note) {
  const list = getNotes();
  if (note.id) {
    const i = list.findIndex((n) => n.id === note.id);
    if (i > -1) list[i] = note; else list.unshift(note);
  } else {
    list.unshift({ ...note, id: uid() });
  }
  store.set('notes', list);
  return list;
}
export function deleteNote(id) {
  store.set('notes', getNotes().filter((n) => n.id !== id));
}

/* ---------------- 实验手记 ---------------- */
export function getLabs() {
  return store.get('labs', []);
}
export function saveLab(lab) {
  const list = getLabs();
  if (lab.id) {
    const i = list.findIndex((l) => l.id === lab.id);
    if (i > -1) list[i] = lab; else list.unshift(lab);
  } else {
    list.unshift({ ...lab, id: uid() });
  }
  store.set('labs', list);
  return list;
}
export function deleteLab(id) {
  store.set('labs', getLabs().filter((l) => l.id !== id));
}

/* ---------------- 书单 / 影视 ---------------- */
export function getBooks() {
  return store.get('books', []);
}
export function saveBook(book) {
  const list = getBooks();
  list.unshift({ ...book, id: uid(), createdAt: Date.now() });
  store.set('books', list);
  return list;
}
export function deleteBook(id) {
  store.set('books', getBooks().filter((b) => b.id !== id));
}
