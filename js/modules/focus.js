/**
 * focus.js — 专注台：番茄钟、每日任务、学习打卡日历、浏览历史
 */
import {
  $, $$, dateKey, parseKey, fmtDateCN, fmtClock, esc, toast, beep, playDone, uid,
} from '../utils.js?v=20261003a';
import {
  store, getTasks, setTasks, addTask, updateTask, removeTask,
  getPomoMinutes, addPomoMinutes, historyList, historyClear,
} from '../storage.js?v=20261003a';

/* ================= 番茄钟 ================= */
const RING_R = 88;
const RING_C = 2 * Math.PI * RING_R; // ≈ 552.92

const pomo = {
  mode: 'work',        // 'work' | 'break'
  total: 25 * 60,
  remaining: 25 * 60,
  running: false,
  timer: null,
};

function pomoLoadSettings() {
  const s = store.get('pomoSettings', { work: 25, brk: 5 });
  return { work: Math.max(1, Math.min(120, s.work || 25)), brk: Math.max(1, Math.min(60, s.brk || 5)) };
}
function pomoSaveSettings() {
  store.set('pomoSettings', { work: Number($('#pomo-work').value) || 25, brk: Number($('#pomo-break').value) || 5 });
}

function pomoRender() {
  const wrap = $('#pomodoro-wrap');
  const mode = pomo.mode === 'work' ? '专注' : '休息';
  wrap.dataset.mode = pomo.mode;
  $('#pomo-mode').textContent = mode;
  $('#pomodoro-time').textContent = fmtClock(pomo.remaining);
  $('#pomo-toggle').textContent = pomo.running ? '暂停' : '开始';
  $('#pomo-mode-chip').textContent = pomo.running ? (pomo.mode === 'work' ? '专注中' : '休息中') : (pomo.mode === 'work' ? '待开始' : '休息待开始');
  const progress = pomo.total ? (pomo.total - pomo.remaining) / pomo.total : 0;
  $('#ring-progress').style.strokeDasharray = RING_C;
  $('#ring-progress').style.strokeDashoffset = RING_C * (1 - progress);
}

function pomoResetToMode(mode) {
  clearInterval(pomo.timer);
  pomo.running = false;
  pomo.mode = mode;
  const s = pomoLoadSettings();
  pomo.total = (mode === 'work' ? s.work : s.brk) * 60;
  pomo.remaining = pomo.total;
  pomoRender();
}

function pomoTick() {
  pomo.remaining -= 1;
  if (pomo.remaining <= 0) {
    clearInterval(pomo.timer);
    pomo.running = false;
    playDone();
    if (pomo.mode === 'work') {
      addPomoMinutes(dateKey(), pomoLoadSettings().work);
      window.dispatchEvent(new CustomEvent('pomo:changed'));
      toast('专注完成，休息一下吧');
      pomoResetToMode('break');
    } else {
      toast('休息结束，开始新的专注');
      pomoResetToMode('work');
    }
    return;
  }
  pomoRender();
}

function pomoToggle() {
  if (pomo.running) {
    clearInterval(pomo.timer);
    pomo.running = false;
  } else {
    if (pomo.remaining <= 0) pomoResetToMode('work');
    pomo.running = true;
    pomo.timer = setInterval(pomoTick, 1000);
    beep(520, 0.1); // 轻提示开始
  }
  pomoRender();
}

function initPomodoro() {
  const s = pomoLoadSettings();
  $('#pomo-work').value = s.work;
  $('#pomo-break').value = s.brk;
  pomoResetToMode('work');

  $('#pomo-toggle').addEventListener('click', pomoToggle);
  $('#pomo-reset').addEventListener('click', () => pomoResetToMode('work'));
  $('#pomo-work').addEventListener('change', () => { pomoSaveSettings(); if (!pomo.running) pomoResetToMode('work'); });
  $('#pomo-break').addEventListener('change', () => { pomoSaveSettings(); if (!pomo.running) pomoResetToMode('work'); });
  // 页面隐藏时降低后台计时误差
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && pomo.running) {
      // 记录暂停时间戳，回显时按真实经过时间校正（简化：切后台仅暂停）
      clearInterval(pomo.timer);
      pomo.running = false;
      pomoRender();
    }
  });
}

/* ================= 每日任务 ================= */
let taskCursor = dateKey(); // 当前展示的任务日期

function taskLabel() {
  const today = dateKey();
  if (taskCursor === today) return '今天';
  const d = parseKey(taskCursor);
  const t = parseKey(today);
  const diff = Math.round((d - t) / 86400000);
  if (diff === -1) return '昨天';
  if (diff === 1) return '明天';
  return fmtDateCN(taskCursor);
}

function renderTasks() {
  const list = getTasks(taskCursor);
  $('#task-date').textContent = taskLabel();
  const ul = $('#task-list');
  if (!list.length) {
    ul.innerHTML = `<li class="empty-note" style="text-align:center;padding:16px 0;">暂无任务，添加一条开始今天的学习吧</li>`;
  } else {
    ul.innerHTML = list.map((t) => `
      <li class="task-item ${t.done ? 'done' : ''}" data-id="${t.id}">
        <input type="checkbox" class="task-check" ${t.done ? 'checked' : ''} aria-label="标记完成">
        <span class="task-text">${esc(t.text)}</span>
        <button class="task-del" aria-label="删除任务">✕</button>
      </li>`).join('');
  }
  // 统计
  const done = list.filter((t) => t.done).length;
  const pct = list.length ? Math.round((done / list.length) * 100) : 0;
  $('#task-stats').innerHTML = list.length
    ? `已完成 ${done} / ${list.length} 项（${pct}%）<div class="bar"><i style="width:${pct}%"></i></div>`
    : '';
}

function initTasks() {
  $('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#task-input');
    const text = input.value.trim();
    if (!text) return;
    addTask(taskCursor, text);
    input.value = '';
    renderTasks();
    toast('任务已添加');
  });
  $('#task-list').addEventListener('change', (e) => {
    const li = e.target.closest('.task-item');
    if (!li) return;
    updateTask(taskCursor, li.dataset.id, { done: e.target.checked });
    renderTasks();
    window.dispatchEvent(new CustomEvent('task:changed'));
  });
  $('#task-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.task-del');
    if (!btn) return;
    const li = btn.closest('.task-item');
    removeTask(taskCursor, li.dataset.id);
    renderTasks();
    toast('任务已删除');
  });
  $('#task-prev').addEventListener('click', () => {
    const d = parseKey(taskCursor); d.setDate(d.getDate() - 1);
    taskCursor = dateKey(d); renderTasks();
  });
  $('#task-next').addEventListener('click', () => {
    const d = parseKey(taskCursor); d.setDate(d.getDate() + 1);
    taskCursor = dateKey(d); renderTasks();
  });
  renderTasks();
}

/* ================= 学习打卡日历 ================= */
let calCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

/** 某天是否打卡：有专注时长或完成任务 */
function hasRecord(key) {
  return getPomoMinutes(key) > 0 || getTasks(key).some((t) => t.done);
}
function dayStats(key) {
  return { minutes: getPomoMinutes(key), done: getTasks(key).filter((t) => t.done).length };
}

function renderCalendar() {
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  $('#cal-title').textContent = `${y}年${m + 1}月`;
  const first = new Date(y, m, 1);
  // 周一为每周第一天
  let lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = dateKey();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="cal-day blank"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cls = ['cal-day'];
    if (key === today) cls.push('today');
    if (hasRecord(key)) cls.push('record');
    cells.push(`<button class="${cls.join(' ')}" data-key="${key}">${d}</button>`);
  }
  $('#cal-grid').innerHTML = cells.join('');

  // 默认选中今天（若在本月）
  const selKey = (today.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`)) ? today : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  showCalDetail(selKey);
}

function showCalDetail(key) {
  const s = dayStats(key);
  const label = key === dateKey() ? '今天' : fmtDateCN(key);
  $('#cal-detail').textContent = `${label}：专注学习 ${s.minutes} 分钟 · 完成任务 ${s.done} 项`;
  $$('#cal-grid .cal-day[data-key]').forEach((b) => {
    b.classList.toggle('today', b.dataset.key === key);
  });
}

function initCalendar() {
  $('#cal-prev').addEventListener('click', () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderCalendar(); });
  $('#cal-next').addEventListener('click', () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderCalendar(); });
  $('#cal-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.cal-day[data-key]');
    if (b) showCalDetail(b.dataset.key);
  });
  window.addEventListener('task:changed', renderCalendar);
  window.addEventListener('pomo:changed', renderCalendar);
  renderCalendar();
}

/* ================= 浏览历史 ================= */
function renderHistory() {
  const list = historyList();
  const ul = $('#history-list');
  if (!list.length) {
    ul.innerHTML = `<li class="empty-note" style="text-align:center;padding:16px 0;">暂无浏览记录。阅读文献、医讯或简报时会自动记录。</li>`;
    return;
  }
  ul.innerHTML = list.map((h) => `
    <li class="history-item">
      <span class="h-type">${h.type === 'paper' ? '文献' : h.type === 'news' ? '医讯' : '简报'}</span>
      <a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>
      <span class="h-time">${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(h.time)}</span>
    </li>`).join('');
}

function initHistory() {
  $('#history-clear').addEventListener('click', () => {
    historyClear();
    renderHistory();
    toast('浏览历史已清空');
  });
  window.addEventListener('history:changed', renderHistory);
  renderHistory();
}

/* ================= 模块入口 ================= */
export function initFocus() {
  initPomodoro();
  initTasks();
  initCalendar();
  initHistory();
}
export function onTabFocus() {
  renderTasks();
  renderCalendar();
  renderHistory();
}
