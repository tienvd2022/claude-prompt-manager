// Màn chính: chọn dự án -> làm việc trong dự án (nhiều tab terminal, panel File/Git).

/* global Terminal, FitAddon */

import { $, el, api, store, projectUrl, timeAgo, toast, confirmDialog, followJob, isTouch, isNarrow } from './common.js';
import { initFiles, setFilesProject, load as loadFiles } from './files.js';
import { initGit, setGitProject, load as loadGit } from './gitpanel.js';

const viewProjects = $('#view-projects');
const viewWorkspace = $('#view-workspace');
const tabsEl = $('#tabs');
const terminalsEl = $('#terminals');
const sessionListEl = $('#session-list');
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

let fontSize = store.get('cpm.fontSize', isTouch ? 12 : 14);
let project = null; // dự án đang mở
let sessions = []; // phiên tmux của dự án đang mở
const tabs = new Map(); // tên phiên -> tab
let active = null;
let panel = store.get('cpm.panel', 'sessions');
let refreshTimer = null;

// ---------- Điều hướng: #/ là danh sách dự án, #/p/<tên> là dự án ----------

function route() {
  const m = location.hash.match(/^#\/p\/(.+)$/);
  const name = m ? decodeURIComponent(m[1]) : null;
  if (name) openProject(name);
  else showProjects();
}
window.addEventListener('hashchange', route);

// ---------- Danh sách dự án ----------

let projectList = [];

async function showProjects() {
  closeProject();
  viewWorkspace.hidden = true;
  viewProjects.hidden = false;
  document.title = 'Dự án · Claude Prompt Manager';
  try {
    const data = await api('GET', '/api/projects');
    projectList = data.projects;
    $('#projects-root').textContent = `Thư mục dự án trên server: ${data.root}`;
  } catch (err) {
    toast(err.message, 'error');
  }
  renderProjects();
}

function renderProjects() {
  const listEl = $('#project-list');
  const q = $('#project-filter').value.trim().toLowerCase();
  const recent = store.get('cpm.recent', {});
  const items = projectList
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => (recent[b.name] || 0) - (recent[a.name] || 0) || a.name.localeCompare(b.name));
  listEl.replaceChildren();
  if (!items.length) {
    listEl.append(el('li', { class: 'muted pad', text: projectList.length ? 'Không có dự án khớp.' : 'Chưa có dự án nào. Bấm "＋ Dự án mới" để tạo hoặc clone.' }));
    return;
  }
  for (const p of items) {
    const meta = [
      p.git ? `⎇ ${p.branch || 'git'}` : 'không có git',
      p.sessions ? `${p.sessions} phiên đang chạy` : '',
      recent[p.name] ? `mở ${timeAgo(recent[p.name])}` : '',
    ].filter(Boolean).join(' · ');
    listEl.append(el('li', {}, el('a', { class: 'project-card', href: `#/p/${encodeURIComponent(p.name)}` },
      el('span', { class: 'project-name', text: p.name }),
      el('span', { class: 'project-meta', text: meta }),
      p.sessions ? el('span', { class: 'dot', title: 'Có phiên đang chạy' }) : null)));
  }
}

$('#project-filter').addEventListener('input', renderProjects);

// Tạo dự án trống hoặc clone từ git.
const dlgProject = $('#dlg-project');
const projectForm = $('#project-form');
let autoName = true;

$('#btn-new-project').addEventListener('click', () => {
  projectForm.reset();
  autoName = true;
  $('#project-error').textContent = '';
  $('#project-job').hidden = true;
  setProjectFormBusy(false);
  dlgProject.showModal();
});

projectForm.gitUrl.addEventListener('input', () => {
  if (!autoName) return;
  const m = projectForm.gitUrl.value.trim().match(/([^/:]+?)(?:\.git)?\/?$/);
  projectForm.name.value = m ? m[1].replace(/[^A-Za-z0-9._-]/g, '-') : '';
});
projectForm.name.addEventListener('input', () => {
  autoName = !projectForm.name.value;
});

function setProjectFormBusy(busy) {
  for (const b of projectForm.querySelectorAll('button, input')) b.disabled = busy;
}

projectForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const name = projectForm.name.value.trim();
  const gitUrl = projectForm.gitUrl.value.trim();
  $('#project-error').textContent = '';
  setProjectFormBusy(true);
  try {
    const res = await api('POST', '/api/projects', { name, gitUrl: gitUrl || undefined });
    if (res.job) {
      const job = await followJob(res.job, $('#project-job'));
      if (job.status !== 'ok') throw new Error('Clone lỗi, xem chi tiết ở trên. Nếu là repo private qua SSH, kiểm tra SSH key trong ⚙ Cài đặt Git.');
    }
    dlgProject.close();
    location.hash = `#/p/${encodeURIComponent(name)}`;
  } catch (err) {
    $('#project-error').textContent = err.message;
  } finally {
    setProjectFormBusy(false);
  }
});

// Cài đặt git chung: tên/email để commit, SSH key để clone/push.
const dlgGit = $('#dlg-git');
const gitForm = $('#git-settings-form');

async function openGitSettings() {
  $('#git-settings-error').textContent = '';
  try {
    renderGitSettings(await api('GET', '/api/git/config'));
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  dlgGit.showModal();
}

function renderGitSettings(cfg) {
  gitForm.name.value = cfg.name;
  gitForm.email.value = cfg.email;
  $('#ssh-key').value = cfg.sshKey || '';
  $('#ssh-key-box').hidden = !cfg.sshKey;
  $('#btn-ssh-create').hidden = !!cfg.sshKey;
}

$('#btn-git-settings').addEventListener('click', openGitSettings);
$('#btn-ssh-create').addEventListener('click', async () => {
  try {
    renderGitSettings(await api('POST', '/api/git/ssh-key'));
  } catch (err) {
    $('#git-settings-error').textContent = err.message;
  }
});
$('#btn-ssh-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#ssh-key').value);
    toast('Đã copy SSH key');
  } catch {
    $('#ssh-key').select();
  }
});
gitForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  try {
    await api('POST', '/api/git/config', { name: gitForm.name.value, email: gitForm.email.value });
    dlgGit.close();
    toast('Đã lưu cài đặt git');
  } catch (err) {
    $('#git-settings-error').textContent = err.message;
  }
});

// ---------- Mở / đóng dự án ----------

async function openProject(name) {
  if (project === name) return;
  closeProject();
  project = name;
  viewProjects.hidden = true;
  viewWorkspace.hidden = false;
  $('#project-title').textContent = name;
  $('#sidebar-title').textContent = name;
  document.title = `${name} · Claude Prompt Manager`;
  const recent = store.get('cpm.recent', {});
  recent[name] = Date.now();
  store.set('cpm.recent', recent);

  setFilesProject(name);
  setGitProject(name);
  if (!isNarrow()) document.body.classList.add('sidebar-open');
  showPanel(panel);
  fitViewport();

  if (!(await refreshSessions())) return;
  const names = new Set(sessions.map((s) => s.name));
  for (const n of store.get(`cpm.tabs.${name}`, [])) if (names.has(n)) openTab(n);
  const last = store.get(`cpm.active.${name}`, null);
  if (last && tabs.has(last)) activate(last);
  emptyEl.hidden = tabs.size > 0;
  refreshTimer = setInterval(() => document.visibilityState === 'visible' && refreshSessions(), 3000);
}

function closeProject() {
  clearInterval(refreshTimer);
  for (const tab of [...tabs.values()]) disposeTab(tab);
  tabs.clear();
  active = null;
  project = null;
  sessions = [];
  hideStatus();
}

// ---------- Panel bên trái: Phiên / File / Git ----------

function showPanel(name) {
  panel = name;
  store.set('cpm.panel', name);
  for (const btn of document.querySelectorAll('[data-panel]')) btn.classList.toggle('active', btn.dataset.panel === name);
  for (const p of ['sessions', 'files', 'git']) $(`#panel-${p}`).hidden = p !== name;
  if (name === 'files') loadFiles();
  if (name === 'git') loadGit();
}

document.querySelectorAll('[data-panel]').forEach((btn) => btn.addEventListener('click', () => showPanel(btn.dataset.panel)));

// ---------- Phiên của dự án ----------

async function refreshSessions() {
  if (!project) return false;
  const current = project;
  try {
    const data = await api('GET', projectUrl(current, '/sessions'));
    if (current !== project) return false;
    sessions = data.sessions;
  } catch (err) {
    toast(err.message, 'error');
    if (/Không có dự án/.test(err.message)) location.hash = '#/';
    return false;
  }
  renderSessions();
  renderTabLabels();
  updateQueueBadge();
  if (queueOf && dlgQueue.open) loadQueue();
  // Tab của phiên đã bị tắt ở nơi khác thì đóng lại.
  for (const name of [...tabs.keys()]) {
    if (!sessions.some((s) => s.name === name)) closeTab(name);
  }
  return true;
}

function sessionLabel(s) {
  const n = s.name.slice(s.name.lastIndexOf('-') + 1);
  const kind = { shell: 'Terminal', 'claude-bypass': '⚠ Claude' }[s.kind] || 'Claude';
  return `${kind} ${n}`;
}

const STATE_TITLE = { busy: 'Claude đang chạy', sent: 'Claude đang chạy', idle: 'Claude đã xong', waiting: 'Claude chờ cho phép', ended: 'Claude đã thoát' };

function renderTabLabels() {
  for (const tab of tabs.values()) {
    const s = sessions.find((x) => x.name === tab.name);
    if (!s) continue;
    tab.labelEl.replaceChildren(
      s.state ? el('span', { class: `tab-dot ${s.state}`, title: STATE_TITLE[s.state] || '' }) : null,
      sessionLabel(s),
      s.queued ? el('span', { class: 'tab-queued', title: `${s.queued} prompt đang chờ`, text: `⏳${s.queued}` }) : null,
    );
  }
}

function renderSessions() {
  sessionListEl.replaceChildren();
  if (!sessions.length) {
    sessionListEl.append(el('li', { class: 'muted pad', text: 'Chưa có phiên nào. Bấm ＋ để mở phiên Claude.' }));
    return;
  }
  for (const s of sessions) {
    const info = el('button', {
      class: 'session-open',
      title: 'Mở phiên',
      onclick: () => {
        openTab(s.name);
        if (isNarrow()) toggleSidebar(false);
      },
    },
    el('span', { class: 'session-name', text: `${sessionLabel(s)}${tabs.has(s.name) ? '' : ' (đang ẩn)'}` }),
    el('span', { class: 'session-meta', text: `${s.name} · ${s.command} · hoạt động ${timeAgo(s.activity)}` }));
    const kill = el('button', { class: 'danger-link', text: 'Kết thúc', onclick: () => confirmKill(s) });
    sessionListEl.append(el('li', { class: `session-item${s.name === active ? ' active' : ''}` }, info, kill));
  }
}

async function confirmKill(s) {
  const what = s.kind === 'shell' ? 'Terminal' : 'Claude';
  if (!(await confirmDialog(`Tắt hẳn phiên "${sessionLabel(s)}"? ${what} đang chạy trong phiên này sẽ bị dừng.`, 'Kết thúc phiên'))) return;
  try {
    await api('DELETE', `/api/sessions/${encodeURIComponent(s.name)}`);
  } catch (err) {
    toast(err.message, 'error');
  }
  closeTab(s.name);
  refreshSessions();
}

// Mở phiên mới: chọn Claude (auto mode) hoặc Terminal.
// Bấm giữ (hoặc chuột phải) nút Claude để hiện thêm lựa chọn bypass permissions.
const dlgNew = $('#dlg-new');
const newClaudeBtn = $('#new-claude');
const bypassBox = $('#new-bypass');
const COMMANDS = ['claude', 'claude-bypass', 'shell'];
let holdTimer = null;
let held = false;

$('#btn-new').addEventListener('click', () => {
  dlgNew.returnValue = '';
  bypassBox.hidden = true;
  dlgNew.showModal();
});
function showBypass() {
  held = true;
  bypassBox.hidden = false;
  navigator.vibrate?.(30);
}
newClaudeBtn.addEventListener('pointerdown', () => {
  held = false;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(showBypass, 600);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
  newClaudeBtn.addEventListener(ev, () => clearTimeout(holdTimer));
}
newClaudeBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  clearTimeout(holdTimer);
  showBypass();
});
// Thả tay sau khi bấm giữ thì không mở phiên Claude thường.
newClaudeBtn.addEventListener('click', (e) => {
  if (held) {
    e.preventDefault();
    held = false;
  }
});
dlgNew.addEventListener('close', async () => {
  const command = dlgNew.returnValue;
  if (!COMMANDS.includes(command)) return;
  try {
    const created = await api('POST', projectUrl(project, '/sessions'), { command });
    await refreshSessions();
    openTab(created.name);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Tab + terminal ----------

function makeTerminal() {
  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
    fontSize,
    cursorBlink: true,
    scrollback: 20000,
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
  const s = sessions.find((x) => x.name === name);

  const elTerm = el('div', { class: 'term' });
  terminalsEl.append(elTerm);
  const { term, fit } = makeTerminal();
  term.open(elTerm);

  const label = el('button', { class: 'tab-label', text: s ? sessionLabel(s) : name, title: name, onclick: () => activate(name) });
  const close = el('button', {
    class: 'tab-close',
    title: 'Ẩn tab (phiên vẫn chạy)',
    text: '×',
    onclick: (e) => {
      e.stopPropagation();
      closeTab(name);
    },
  });
  const tabEl = el('div', { class: 'tab' }, label, close);
  tabsEl.append(tabEl);

  const tab = { name, el: elTerm, tabEl, labelEl: label, term, fit, ws: null, retry: 0, closed: false, timer: null };
  tabs.set(name, tab);
  renderTabLabels();

  term.onData((data) => {
    if (ctrlArmed) {
      armCtrl(false);
      data = withCtrl(data);
    }
    send(tab, data);
  });
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
  renderSessions();
  updateQueueBadge();
  if (project) store.set(`cpm.active.${project}`, name);
}

function disposeTab(tab) {
  tab.closed = true;
  clearTimeout(tab.timer);
  tab.ws?.close();
  tab.term.dispose();
  tab.el.remove();
  tab.tabEl.remove();
}

function closeTab(name) {
  const tab = tabs.get(name);
  if (!tab) return;
  disposeTab(tab);
  tabs.delete(name);
  saveOpenTabs();
  if (active === name) {
    const next = [...tabs.keys()].pop();
    if (next) activate(next);
    else {
      active = null;
      emptyEl.hidden = false;
      hideStatus();
    }
  }
  renderSessions();
}

function saveOpenTabs() {
  if (project) store.set(`cpm.tabs.${project}`, [...tabs.keys()]);
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
      if (tabs.get(tab.name) === tab) connect(tab);
    }, delay);
  });
}

function send(tab, data) {
  if (tab?.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data }));
}

// ---------- Trạng thái kết nối ----------

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

// ---------- Thanh phím + ô prompt (tiện cho điện thoại) ----------

// Mỗi nút trên thanh phím: nhãn, mô tả (hiện trong màn sửa) và việc cần làm khi bấm.
const keyBtn = (label, title, key) => ({ label, title, key });
const BAR_BUTTONS = {
  esc: keyBtn('Esc', 'Esc', 'esc'),
  tab: keyBtn('Tab', 'Tab', 'tab'),
  up: keyBtn('↑', 'Mũi tên lên', 'up'),
  down: keyBtn('↓', 'Mũi tên xuống', 'down'),
  left: keyBtn('←', 'Mũi tên trái', 'left'),
  right: keyBtn('→', 'Mũi tên phải', 'right'),
  'ctrl-c': keyBtn('^C', 'Ctrl+C', 'ctrl-c'),
  ctrl: { label: 'Ctrl', title: 'Giữ Ctrl cho phím gõ tiếp theo', run: () => armCtrl(!ctrlArmed) },
  enter: keyBtn('⏎', 'Enter', 'enter'),
  history: { label: '🕘', title: 'Lịch sử prompt', run: () => showHistory() },
  queue: { label: '📋', title: 'Hàng đợi prompt', run: () => showQueue() },
  text: { label: '📄', title: 'Xem/copy nội dung dạng chữ', run: () => showText() },
  'shift-tab': keyBtn('⇧Tab', 'Shift+Tab (đổi chế độ Claude)', 'shift-tab'),
  'font-down': { label: 'A−', title: 'Chữ nhỏ hơn', run: () => setFont(fontSize - 1) },
  'font-up': { label: 'A+', title: 'Chữ to hơn', run: () => setFont(fontSize + 1) },
};
const BAR_DEFAULT = Object.keys(BAR_BUTTONS);
const keybarEl = $('#keybar');

// Cấu hình lưu dạng [{ id, show }]; nút mới thêm sau này tự hiện ở cuối.
function loadKeybar() {
  const saved = store.get('cpm.keybar', null);
  const list = Array.isArray(saved) ? saved.filter((b) => BAR_BUTTONS[b?.id]) : [];
  for (const id of BAR_DEFAULT) if (!list.some((b) => b.id === id)) list.push({ id, show: true });
  return list;
}
let keybar = loadKeybar();

const barEls = {}; // id -> nút đang hiện, để cập nhật trạng thái (Ctrl đang giữ, số prompt chờ)

function renderKeybar() {
  keybarEl.replaceChildren();
  for (const id of Object.keys(barEls)) delete barEls[id];
  for (const { id, show } of keybar) {
    if (!show) continue;
    const def = BAR_BUTTONS[id];
    barEls[id] = el('button', {
      type: 'button',
      title: def.title,
      text: def.label,
      onclick: () => {
        if (def.run) return def.run();
        const tab = tabs.get(active);
        send(tab, ctrlArmed && CTRL_KEYS[def.key] ? CTRL_KEYS[def.key] : KEYS[def.key]);
        armCtrl(false);
        if (!isTouch) tab?.term.focus();
      },
    });
    keybarEl.append(barEls[id]);
  }
  armCtrl(ctrlArmed);
  updateQueueBadge();
  keybarEl.append(el('button', { type: 'button', title: 'Sửa thanh phím', 'aria-label': 'Sửa thanh phím', text: '⋯', onclick: editKeybar }));
}

function saveKeybar() {
  store.set('cpm.keybar', keybar);
  renderKeybar();
  renderKeybarEdit();
}

function renderKeybarEdit() {
  const listEl = $('#keybar-edit');
  listEl.replaceChildren(...keybar.map((b, i) => {
    const def = BAR_BUTTONS[b.id];
    const move = (d) => {
      [keybar[i], keybar[i + d]] = [keybar[i + d], keybar[i]];
      saveKeybar();
    };
    return el('li', {},
      el('label', { class: 'inline' },
        el('input', { type: 'checkbox', checked: b.show, onchange: (e) => { b.show = e.target.checked; saveKeybar(); } }),
        el('span', { class: 'key-label', text: def.label }),
        el('span', { class: 'muted small', text: def.title })),
      el('button', { type: 'button', class: 'icon-btn small', 'aria-label': `Đưa ${def.title} lên`, text: '↑', disabled: i === 0, onclick: () => move(-1) }),
      el('button', { type: 'button', class: 'icon-btn small', 'aria-label': `Đưa ${def.title} xuống`, text: '↓', disabled: i === keybar.length - 1, onclick: () => move(1) }));
  }));
}

function editKeybar() {
  renderKeybarEdit();
  $('#dlg-keybar').showModal();
}
$('#keybar-reset').addEventListener('click', () => {
  keybar = BAR_DEFAULT.map((id) => ({ id, show: true }));
  saveKeybar();
});

// Ctrl giữ: bấm Ctrl rồi gõ một phím (vào terminal hoặc trên thanh phím) để gửi Ctrl+phím đó.
let ctrlArmed = false;
const CTRL_KEYS = { up: '\x1b[1;5A', down: '\x1b[1;5B', right: '\x1b[1;5C', left: '\x1b[1;5D' };
const CTRL_PUNCT = { '@': '\x00', ' ': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f', '?': '\x7f' };

function armCtrl(on) {
  ctrlArmed = on;
  barEls.ctrl?.classList.toggle('armed', on);
  if (on) tabs.get(active)?.term.focus();
}

function withCtrl(data) {
  if (/^[a-z]$/i.test(data)) return String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
  return CTRL_PUNCT[data] ?? data;
}

function setFont(size) {
  fontSize = Math.max(9, Math.min(24, size));
  store.set('cpm.fontSize', fontSize);
  for (const t of tabs.values()) {
    t.term.options.fontSize = fontSize;
    safeFit(t);
  }
}

renderKeybar();

// Lịch sử các prompt đã gửi từ ô prompt (lưu trên trình duyệt này, mới nhất trước).
const HISTORY_MAX = 100;

function rememberPrompt(text) {
  const list = store.get('cpm.promptHistory', []).filter((t) => t !== text);
  list.unshift(text);
  store.set('cpm.promptHistory', list.slice(0, HISTORY_MAX));
}

function showHistory() {
  const dlg = $('#dlg-history');
  const list = store.get('cpm.promptHistory', []);
  const listEl = $('#history-list');
  listEl.replaceChildren(...list.map((text) => el('li', {}, el('button', {
    type: 'button',
    class: 'prompt-text',
    text,
    onclick: () => {
      dlg.close();
      promptInput.value = text;
      autoGrow();
      promptInput.focus();
    },
  }))));
  if (!list.length) listEl.append(el('li', { class: 'muted small', text: 'Chưa có prompt nào.' }));
  dlg.showModal();
}
$('#history-clear').addEventListener('click', async () => {
  $('#dlg-history').close();
  if (await confirmDialog('Xóa toàn bộ lịch sử prompt trên trình duyệt này?', 'Xóa')) store.set('cpm.promptHistory', []);
});

// Xem nội dung phiên dạng chữ thường: chọn/copy bằng thao tác bình thường của trình duyệt,
// vì chọn chữ trong terminal trên điện thoại gần như không dùng được.
const dlgText = $('#dlg-text');
const textBody = $('#text-body');

async function showText() {
  if (!active) return toast('Mở một phiên trước (bấm ＋)', 'error');
  textBody.textContent = 'Đang tải…';
  dlgText.showModal();
  try {
    const { text } = await api('GET', `/api/sessions/${encodeURIComponent(active)}/text`);
    textBody.textContent = text.replace(/\s+$/, '') || '(trống)';
    textBody.scrollTop = textBody.scrollHeight;
  } catch (err) {
    textBody.textContent = err.message;
  }
}

async function copyText(text) {
  // navigator.clipboard chỉ có trên HTTPS/localhost; mở qua IP LAN thì dùng cách cũ.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    ta.value = text;
    dlgText.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

$('#text-copy').addEventListener('click', async () => {
  const sel = String(getSelection());
  const ok = await copyText(sel || textBody.textContent);
  toast(ok ? (sel ? 'Đã copy đoạn đã chọn' : 'Đã copy hết') : 'Trình duyệt chặn copy, hãy chọn chữ rồi copy tay', ok ? undefined : 'error');
});

// Hàng đợi prompt của phiên đang mở: nằm trên server, tự gửi khi hook báo Claude xong lượt.
const STATE_TEXT = {
  busy: 'Claude đang chạy. Prompt sẽ được gửi khi Claude xong.',
  sent: 'Vừa gửi prompt, đang chờ Claude nhận.',
  idle: 'Claude đang rảnh: prompt thêm vào sẽ được gửi ngay.',
  waiting: 'Claude đang chờ anh cho phép. Hàng đợi tạm dừng.',
  ended: 'Claude đã thoát. Hàng đợi không gửi gì vào shell.',
};
const dlgQueue = $('#dlg-queue');
const queueUrl = (name) => `/api/sessions/${encodeURIComponent(name)}/queue`;
let queueItems = [];
let queueOf = null;

function activeSession() {
  return sessions.find((s) => s.name === active);
}

function updateQueueBadge() {
  const n = activeSession()?.queued || 0;
  if (barEls.queue) barEls.queue.textContent = n ? `📋${n}` : '📋';
}

async function showQueue() {
  const s = activeSession();
  if (!s) return toast('Mở một phiên trước (bấm ＋)', 'error');
  queueOf = s.name;
  queueItems = [];
  renderQueue();
  dlgQueue.showModal();
  await loadQueue();
}

async function loadQueue() {
  if (!queueOf) return;
  try {
    queueItems = (await api('GET', queueUrl(queueOf))).items;
  } catch (err) {
    toast(err.message, 'error');
  }
  renderQueue();
}

function renderQueue() {
  const s = sessions.find((x) => x.name === queueOf);
  $('h2', dlgQueue).textContent = `Hàng đợi · ${s ? sessionLabel(s) : queueOf}`;
  $('#queue-state').textContent = s?.kind === 'shell'
    ? 'Phiên Terminal không có trạng thái, hàng đợi chỉ gửi khi bấm "Gửi tiếp ngay".'
    : STATE_TEXT[s?.state] || 'Chưa biết trạng thái (phiên mở trước khi có hàng đợi): mở phiên Claude mới, hoặc bấm "Gửi tiếp ngay".';
  const listEl = $('#queue-list');
  listEl.replaceChildren(...queueItems.map((item, i) => {
    const move = (d) => {
      [queueItems[i], queueItems[i + d]] = [queueItems[i + d], queueItems[i]];
      saveQueue();
    };
    return el('li', { class: 'queue-item' },
      el('button', {
        type: 'button',
        class: 'prompt-text queue-text',
        title: 'Lấy ra ô prompt để sửa',
        text: item.text,
        onclick: () => {
          queueItems.splice(i, 1);
          saveQueue();
          dlgQueue.close();
          promptInput.value = item.text;
          autoGrow();
          promptInput.focus();
        },
      }),
      el('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Lên', text: '↑', disabled: i === 0, onclick: () => move(-1) }),
      el('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Xuống', text: '↓', disabled: i === queueItems.length - 1, onclick: () => move(1) }),
      el('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Xóa', text: '✕', onclick: () => { queueItems.splice(i, 1); saveQueue(); } }));
  }));
  if (!queueItems.length) listEl.append(el('li', { class: 'muted small', text: 'Hàng đợi trống. Gõ prompt rồi bấm ⏳ để thêm.' }));
  $('#queue-next').disabled = !queueItems.length;
}

async function saveQueue() {
  renderQueue();
  try {
    queueItems = (await api('PUT', queueUrl(queueOf), { items: queueItems })).items;
  } catch (err) {
    toast(err.message, 'error');
  }
  renderQueue();
  refreshSessions();
}

$('#queue-next').addEventListener('click', async () => {
  try {
    queueItems = (await api('POST', `${queueUrl(queueOf)}/next`)).items;
    toast('Đã gửi prompt tiếp theo');
  } catch (err) {
    toast(err.message, 'error');
  }
  renderQueue();
  refreshSessions();
});
dlgQueue.addEventListener('close', () => { queueOf = null; });

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
  if (!tab) {
    toast('Mở một phiên trước (bấm ＋)', 'error');
    return;
  }
  if (!text) return;
  rememberPrompt(text);
  // Dán theo kiểu bracketed paste để xuống dòng không bị hiểu là Enter, rồi mới gửi Enter.
  send(tab, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  setTimeout(() => send(tab, '\r'), 80);
  promptInput.value = '';
  autoGrow();
});

$('#prompt-queue').addEventListener('click', async () => {
  const s = activeSession();
  const text = promptInput.value;
  if (!s) return toast('Mở một phiên trước (bấm ＋)', 'error');
  if (!text.trim()) return showQueue();
  try {
    const { items } = await api('POST', queueUrl(s.name), { text });
    rememberPrompt(text);
    promptInput.value = '';
    autoGrow();
    toast(s.state === 'idle' ? 'Claude đang rảnh, gửi ngay' : `Đã xếp hàng (${items.length} prompt đang chờ)`);
  } catch (err) {
    toast(err.message, 'error');
  }
  refreshSessions();
});

// Chèn đường dẫn file (từ panel File) vào ô prompt, dạng @path mà Claude hiểu.
function insertPath(rel) {
  const v = promptInput.value;
  promptInput.value = `${v}${v && !/\s$/.test(v) ? ' ' : ''}@${rel} `;
  autoGrow();
  if (isNarrow()) toggleSidebar(false);
  promptInput.focus();
}

// Ảnh dán hoặc đính kèm: upload vào .cpm/paste của dự án rồi chèn @đường-dẫn vào prompt.
async function attachImages(list) {
  const images = list.filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  if (!project) {
    toast('Chọn dự án trước', 'error');
    return;
  }
  for (const file of images) {
    try {
      const res = await fetch(projectUrl(project, '/paste'), { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      if (res.status === 401) location.href = '/login';
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || (res.status === 413 ? 'Ảnh quá lớn' : `Lỗi ${res.status}`));
      insertPath(data.path);
    } catch (err) {
      toast(`Không gửi được ảnh: ${err.message}`, 'error');
    }
  }
}

promptInput.addEventListener('paste', (e) => {
  const list = [...(e.clipboardData?.files || [])];
  if (!list.some((f) => f.type.startsWith('image/'))) return;
  e.preventDefault();
  attachImages(list);
});

const promptImage = $('#prompt-image');
$('#prompt-attach').addEventListener('click', () => promptImage.click());
promptImage.addEventListener('change', () => {
  attachImages([...promptImage.files]);
  promptImage.value = '';
});

// ---------- Bố cục ----------

function toggleSidebar(force) {
  document.body.classList.toggle('sidebar-open', force ?? !document.body.classList.contains('sidebar-open'));
  requestAnimationFrame(() => tabs.get(active) && safeFit(tabs.get(active)));
}

$('#btn-sidebar').addEventListener('click', () => toggleSidebar());
$('#btn-back').addEventListener('click', () => { location.hash = '#/'; });
$('#btn-refresh').addEventListener('click', refreshSessions);
document.querySelectorAll('.btn-logout').forEach((btn) => btn.addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  location.href = '/login';
}));

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
  if (document.visibilityState !== 'visible') return;
  if (project) refreshSessions();
  else if (!viewProjects.hidden) showProjects();
});

// ---------- Khởi động ----------

initFiles({ insertPath });
initGit();
fitViewport();
route();
