'use strict';

/* global Terminal, FitAddon */

const $ = (sel) => document.querySelector(sel);
const tabsEl = $('#tabs');
const terminalsEl = $('#terminals');
const listEl = $('#session-list');
const statusEl = $('#status');
const emptyEl = $('#empty');

const KEYS = {
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  enter: '\r',
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // trình duyệt chặn storage thì bỏ qua
    }
  },
};

const isTouch = matchMedia('(pointer: coarse)').matches;
let fontSize = store.get('cpm.fontSize', isTouch ? 12 : 14);
let sessions = [];
const tabs = new Map(); // name -> tab
let active = null;

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Chưa đăng nhập');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

async function refreshSessions() {
  try {
    sessions = (await api('GET', '/api/sessions')).sessions;
  } catch (err) {
    showStatus(err.message);
    return;
  }
  renderList();
  // Tab của phiên đã bị tắt ở nơi khác thì đóng lại.
  for (const name of [...tabs.keys()]) {
    if (!sessions.some((s) => s.name === name)) closeTab(name);
  }
}

// ---------- Danh sách phiên ----------

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

function renderList() {
  listEl.replaceChildren();
  if (!sessions.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Chưa có phiên nào.';
    listEl.append(li);
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.name === active ? ' active' : '');

    const info = document.createElement('button');
    info.className = 'session-open';
    info.title = 'Mở phiên';
    const title = document.createElement('span');
    title.className = 'session-name';
    title.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `${s.command} · ${s.cwd.replace(/^\/home\/[^/]+/, '~')} · hoạt động ${timeAgo(s.activity)}`;
    info.append(title, meta);
    info.addEventListener('click', () => {
      openTab(s.name);
      if (isNarrow()) toggleSidebar(false);
    });

    const kill = document.createElement('button');
    kill.className = 'danger-link';
    kill.textContent = 'Kết thúc';
    kill.addEventListener('click', () => confirmKill(s.name));

    li.append(info, kill);
    listEl.append(li);
  }
}

// ---------- Tab + terminal ----------

function makeTerminal() {
  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
    fontSize,
    cursorBlink: true,
    scrollback: 20000,
    allowProposedApi: false,
    theme: {
      background: '#1a1917',
      foreground: '#e8e4dc',
      cursor: '#e8875b',
      selectionBackground: '#4a453e',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

function openTab(name) {
  if (tabs.has(name)) return activate(name);

  const el = document.createElement('div');
  el.className = 'term';
  terminalsEl.append(el);
  const { term, fit } = makeTerminal();
  term.open(el);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const label = document.createElement('button');
  label.className = 'tab-label';
  label.textContent = name;
  label.addEventListener('click', () => activate(name));
  const close = document.createElement('button');
  close.className = 'tab-close';
  close.title = 'Đóng tab (phiên vẫn chạy)';
  close.textContent = '×';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(name);
  });
  tabEl.append(label, close);
  tabsEl.append(tabEl);

  const tab = { name, el, tabEl, term, fit, ws: null, retry: 0, closed: false, timer: null };
  tabs.set(name, tab);

  term.onData((data) => send(tab, data));
  term.onResize(({ cols, rows }) => {
    if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });

  activate(name);
  connect(tab);
  saveOpenTabs();
}

function activate(name) {
  active = name;
  for (const t of tabs.values()) {
    const on = t.name === name;
    t.el.classList.toggle('visible', on);
    t.tabEl.classList.toggle('active', on);
  }
  emptyEl.hidden = tabs.size > 0;
  const tab = tabs.get(name);
  if (tab) {
    requestAnimationFrame(() => {
      safeFit(tab);
      if (!isTouch) tab.term.focus();
    });
    tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateStatus(tab);
  }
  renderList();
  store.set('cpm.active', name);
}

function closeTab(name) {
  const tab = tabs.get(name);
  if (!tab) return;
  tab.closed = true;
  clearTimeout(tab.timer);
  tab.ws?.close();
  tab.term.dispose();
  tab.el.remove();
  tab.tabEl.remove();
  tabs.delete(name);
  saveOpenTabs();
  if (active === name) {
    const next = [...tabs.keys()].pop();
    if (next) activate(next);
    else {
      active = null;
      emptyEl.hidden = false;
      hideStatus();
      renderList();
    }
  }
}

function saveOpenTabs() {
  store.set('cpm.tabs', [...tabs.keys()]);
}

function safeFit(tab) {
  if (!tab.el.classList.contains('visible')) return;
  try {
    tab.fit.fit();
  } catch {
    // terminal chưa có kích thước
  }
}

function connect(tab) {
  if (tab.closed) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ session: tab.name, cols: tab.term.cols, rows: tab.term.rows });
  const ws = new WebSocket(`${proto}//${location.host}/ws?${qs}`);
  tab.ws = ws;
  tab.state = 'connecting';
  updateStatus(tab);

  ws.addEventListener('open', () => {
    tab.retry = 0;
    tab.state = 'open';
    tab.term.reset();
    updateStatus(tab);
    safeFit(tab);
  });
  ws.addEventListener('message', (e) => tab.term.write(e.data));
  ws.addEventListener('close', (e) => {
    if (tab.ws !== ws || tab.closed) return;
    if (e.code === 4001) {
      location.href = '/login';
      return;
    }
    if (e.code === 4000) {
      tab.state = 'ended';
      updateStatus(tab);
      refreshSessions();
      return;
    }
    tab.state = 'reconnecting';
    updateStatus(tab);
    const delay = Math.min(10000, 500 * 2 ** tab.retry++);
    tab.timer = setTimeout(async () => {
      await refreshSessions();
      if (tabs.has(tab.name)) connect(tab);
    }, delay);
  });
}

function send(tab, data) {
  if (tab?.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data }));
}

// ---------- Trạng thái ----------

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

function hideStatus() {
  statusEl.hidden = true;
}

function updateStatus(tab) {
  if (tab.name !== active) return;
  if (tab.state === 'open') hideStatus();
  else if (tab.state === 'connecting') showStatus('Đang kết nối…');
  else if (tab.state === 'reconnecting') showStatus('Mất kết nối, đang nối lại…');
  else if (tab.state === 'ended') showStatus('Phiên đã kết thúc.');
}

// ---------- Hộp thoại ----------

function defaultName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `s${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const dlgNew = $('#dlg-new');
const newForm = $('#new-form');

$('#btn-new').addEventListener('click', () => {
  newForm.name.value = defaultName();
  newForm.cwd.value = store.get('cpm.lastCwd', '~');
  $('#new-error').textContent = '';
  dlgNew.showModal();
  newForm.name.select();
});

newForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const body = { name: newForm.name.value.trim(), cwd: newForm.cwd.value.trim(), command: newForm.command.value };
  try {
    await api('POST', '/api/sessions', body);
    store.set('cpm.lastCwd', body.cwd);
    dlgNew.close();
    await refreshSessions();
    openTab(body.name);
  } catch (err) {
    $('#new-error').textContent = err.message;
  }
});

const dlgConfirm = $('#dlg-confirm');

function confirmKill(name) {
  $('#confirm-text').textContent = `Tắt hẳn phiên "${name}"? Claude đang chạy trong phiên này sẽ bị dừng.`;
  dlgConfirm.returnValue = '';
  dlgConfirm.onclose = async () => {
    if (dlgConfirm.returnValue !== 'ok') return;
    try {
      await api('DELETE', `/api/sessions/${encodeURIComponent(name)}`);
    } catch (err) {
      showStatus(err.message);
    }
    closeTab(name);
    refreshSessions();
  };
  dlgConfirm.showModal();
}

// ---------- Thanh phím + ô prompt (tiện cho điện thoại) ----------

document.querySelectorAll('[data-key]').forEach((btn) => {
  btn.addEventListener('click', () => {
    send(tabs.get(active), KEYS[btn.dataset.key]);
    if (!isTouch) tabs.get(active)?.term.focus();
  });
});

function setFont(size) {
  fontSize = Math.max(9, Math.min(24, size));
  store.set('cpm.fontSize', fontSize);
  for (const t of tabs.values()) {
    t.term.options.fontSize = fontSize;
    safeFit(t);
  }
}
$('#font-down').addEventListener('click', () => setFont(fontSize - 1));
$('#font-up').addEventListener('click', () => setFont(fontSize + 1));

const promptForm = $('#prompt-form');
const promptInput = $('#prompt-input');

function autoGrow() {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 160)}px`;
}
promptInput.addEventListener('input', autoGrow);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    promptForm.requestSubmit();
  }
});

promptForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const tab = tabs.get(active);
  const text = promptInput.value;
  if (!tab || !text) return;
  // Dán theo kiểu bracketed paste để xuống dòng không bị hiểu là Enter, rồi mới gửi Enter.
  send(tab, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  setTimeout(() => send(tab, '\r'), 80);
  promptInput.value = '';
  autoGrow();
});

// ---------- Bố cục ----------

const isNarrow = () => matchMedia('(max-width: 760px)').matches;

function toggleSidebar(force) {
  document.body.classList.toggle('sidebar-open', force ?? !document.body.classList.contains('sidebar-open'));
  requestAnimationFrame(() => tabs.get(active) && safeFit(tabs.get(active)));
}

$('#btn-sidebar').addEventListener('click', () => toggleSidebar());
$('#btn-refresh').addEventListener('click', refreshSessions);
$('#btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  location.href = '/login';
});

// Bàn phím điện thoại bật lên thì co app lại cho vừa phần nhìn thấy.
function fitViewport() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${h}px`);
  const tab = tabs.get(active);
  if (tab) safeFit(tab);
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
new ResizeObserver(() => {
  const tab = tabs.get(active);
  if (tab) safeFit(tab);
}).observe(terminalsEl);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSessions();
});

// ---------- Khởi động ----------

(async () => {
  if (!isNarrow()) document.body.classList.add('sidebar-open');
  fitViewport();
  await refreshSessions();
  const names = new Set(sessions.map((s) => s.name));
  for (const name of store.get('cpm.tabs', [])) if (names.has(name)) openTab(name);
  const last = store.get('cpm.active', null);
  if (last && tabs.has(last)) activate(last);
  emptyEl.hidden = tabs.size > 0;
  setInterval(refreshSessions, 10000);
})();
