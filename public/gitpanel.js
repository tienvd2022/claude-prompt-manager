// Panel git của dự án: nhánh, thay đổi, commit, lịch sử, fetch/pull/push và tự đồng bộ.

import { $, el, api, projectUrl, timeAgo, toast, showText, followJob, store } from './common.js';
import { openViewer } from './viewer.js';

const infoEl = $('#git-info');
const changesEl = $('#git-changes');
const logEl = $('#git-log');
const jobEl = $('#git-job');
const repoEl = $('#git-repo');
const noRepoEl = $('#git-norepo');
const commitForm = $('#git-commit-form');
const autoSyncBox = $('#git-autosync');
const dlgBranch = $('#dlg-branch');
const branchForm = $('#branch-form');

const SYNC_EVERY_MS = 10000;
const XY_LABEL = { M: 'sửa', A: 'thêm', D: 'xóa', R: 'đổi tên', C: 'chép', U: 'xung đột', T: 'đổi loại' };

let project = null;
let running = false; // đang chạy fetch/pull/push (bấm tay hoặc tự đồng bộ)
let view = 'changes';
let commit = null; // commit đang xem chi tiết
let lastStatus = null;

// Tự đồng bộ: bật/tắt lưu riêng từng dự án trên trình duyệt.
const syncKey = (p) => `cpm.gitAutoSync.${p}`;
let syncTimer = null;
let syncing = false;
let pushTried = null; // HEAD đã thử tự push, để push lỗi thì không thử lại mãi
let syncNote = '';

export function initGit() {
  $('#git-refresh').addEventListener('click', () => load());
  document.querySelectorAll('[data-git]').forEach((btn) => btn.addEventListener('click', () => runRemote(btn.dataset.git)));
  document.querySelectorAll('[data-gitview]').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.gitview)));
  $('#git-commit-back').addEventListener('click', () => setView('log'));
  $('#git-commit-all').addEventListener('click', async () => {
    if (!commit) return;
    try {
      showText(`${commit.short} ${commit.subject}`, (await api('GET', projectUrl(project, `/git/show?hash=${commit.hash}`))).text);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#git-branch').addEventListener('click', openBranches);
  branchForm.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'create') return;
    e.preventDefault();
    const name = branchForm.name.value.trim();
    if (name) switchBranch(name, true);
  });
  autoSyncBox.addEventListener('change', () => {
    store.set(syncKey(project), autoSyncBox.checked);
    syncNote = '';
    if (autoSyncBox.checked) startAutoSync();
    else stopAutoSync();
    if (lastStatus) renderInfo(lastStatus);
  });
  $('#git-init').addEventListener('click', async () => {
    try {
      await api('POST', projectUrl(project, '/git/init'));
      toast('Đã tạo repo git');
    } catch (err) {
      toast(err.message, 'error');
    }
    load();
  });
  commitForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = commitForm.message.value.trim();
    if (!message) return;
    try {
      const { output } = await api('POST', projectUrl(project, '/git/commit'), { message });
      commitForm.message.value = '';
      toast(output.split('\n')[0] || 'Đã commit');
    } catch (err) {
      toast(err.message, 'error');
    }
    await load();
    syncTick();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncTick();
  });
}

export function setGitProject(name) {
  if (project === name) return;
  stopAutoSync();
  project = name;
  jobEl.hidden = true;
  infoEl.replaceChildren();
  changesEl.replaceChildren();
  logEl.replaceChildren();
  commit = null;
  lastStatus = null;
  syncNote = '';
  pushTried = null;
  if (view === 'commit') view = 'log';
  showView();
  autoSyncBox.checked = !!name && store.get(syncKey(name), false);
  if (autoSyncBox.checked) startAutoSync();
}

export async function load() {
  if (!project) return;
  const current = project;
  let st;
  try {
    st = await api('GET', projectUrl(current, '/git/status'));
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (current !== project) return;
  render(st);
  if (!st.repo) return;
  if (view === 'log') loadLog();
  if (view === 'commit' && commit) loadCommit(commit);
}

function render(st) {
  lastStatus = st;
  repoEl.hidden = !st.repo;
  noRepoEl.hidden = st.repo;
  if (!st.repo) return;
  renderInfo(st);
  renderChanges(st);
}

async function loadLog() {
  const current = project;
  try {
    const { commits } = await api('GET', projectUrl(current, '/git/log'));
    if (current === project) renderLog(commits);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setView(name) {
  view = name;
  showView();
  if (name === 'log') loadLog();
}

function showView() {
  $('#git-view-changes').hidden = view !== 'changes';
  $('#git-view-log').hidden = view !== 'log';
  $('#git-view-commit').hidden = view !== 'commit';
  const tab = view === 'commit' ? 'log' : view;
  document.querySelectorAll('[data-gitview]').forEach((b) => b.classList.toggle('active', b.dataset.gitview === tab));
}

function renderInfo(st) {
  $('#git-branch-name').textContent = st.branch && st.branch !== '(detached)' ? st.branch : `(tách rời ${st.head?.slice(0, 7) || ''})`;
  const sync = st.upstream
    ? [st.ahead ? `↑${st.ahead} chưa push` : '', st.behind ? `↓${st.behind} chưa pull` : ''].filter(Boolean).join(' · ') || 'đã đồng bộ'
    : 'chưa có nhánh trên remote';
  infoEl.replaceChildren(...[
    el('div', { class: 'small' }, st.upstream ? el('span', { class: 'muted', text: `${st.upstream}: ` }) : null, el('span', { text: sync })),
    el('div', { class: 'muted small ellipsis', title: st.remote || '', text: st.remote ? `origin: ${st.remote}` : 'Chưa có remote origin' }),
    autoSyncBox.checked && syncNote ? el('div', { class: 'muted small', text: `Tự đồng bộ: ${syncNote}` }) : null,
  ].filter(Boolean));
}

function changeCode(c) {
  return c.untracked ? '?' : c.conflict ? 'U' : (c.xy[0] !== '.' ? c.xy[0] : c.xy[1]);
}

function renderChanges(st) {
  $('#git-count').textContent = st.total || st.changes.length;
  changesEl.replaceChildren();
  commitForm.hidden = !st.changes.length;
  if (!st.changes.length) {
    changesEl.append(el('li', { class: 'muted pad', text: 'Không có thay đổi.' }));
    return;
  }
  for (const c of st.changes) {
    const code = changeCode(c);
    const label = c.untracked ? 'mới' : XY_LABEL[code] || code;
    const diff = () => {
      const qs = new URLSearchParams({ path: c.path });
      if (c.untracked) qs.set('untracked', '1');
      return api('GET', projectUrl(project, `/git/diff?${qs}`)).then((r) => r.text);
    };
    // File đã xóa thì xem bản ở HEAD.
    const rev = code === 'D' ? st.head : null;
    const open = (mode) => openViewer({ project, path: c.path, rev, diff, mode, onSaved: () => load() });
    changesEl.append(fileRow(code, label, c.from ? `${c.from} → ${c.path}` : c.path, open, !c.path.endsWith('/')));
  }
}

// Một dòng file: bấm để xem diff, nút 📄 để xem nội dung file.
function fileRow(code, label, text, open, canView = true) {
  return el('li', { class: 'change-row' },
    el('button', { class: 'change', title: 'Xem thay đổi', onclick: () => open('diff') },
      el('span', { class: `badge s-${code}`, text: label }),
      el('span', { class: 'ellipsis', text })),
    canView ? el('button', { class: 'icon-btn small', title: 'Xem file', 'aria-label': `Xem file ${text}`, text: '📄', onclick: () => open('file') }) : null);
}

function renderLog(commits) {
  logEl.replaceChildren();
  if (!commits.length) {
    logEl.append(el('li', { class: 'muted pad', text: 'Chưa có commit nào.' }));
    return;
  }
  for (const c of commits) {
    logEl.append(el('li', {}, el('button', {
      class: 'commit',
      title: 'Xem file thay đổi trong commit',
      onclick: () => {
        commit = c;
        setView('commit');
        loadCommit(c);
      },
    },
    el('span', { class: 'commit-subject ellipsis', text: c.subject }),
    el('span', { class: 'muted small ellipsis', text: `${c.short} · ${c.author} · ${timeAgo(c.time)}${c.refs ? ` · ${c.refs}` : ''}` }))));
  }
}

async function loadCommit(c) {
  const head = $('#git-commit-head');
  const list = $('#git-commit-files');
  head.replaceChildren(
    el('div', { class: 'commit-subject commit-meta', text: c.subject }),
    el('div', { class: 'muted small', text: `${c.short} · ${c.author} · ${new Date(c.time).toLocaleString()}` }),
  );
  list.replaceChildren(el('li', { class: 'muted pad', text: 'Đang tải…' }));
  const current = project;
  let data;
  try {
    data = await api('GET', projectUrl(current, `/git/commit-files?hash=${c.hash}`));
  } catch (err) {
    list.replaceChildren(el('li', { class: 'muted pad', text: err.message }));
    return;
  }
  if (current !== project || commit !== c) return;
  list.replaceChildren();
  if (!data.files.length) list.append(el('li', { class: 'muted pad', text: 'Commit không đổi file nào.' }));
  for (const f of data.files) {
    const diff = () => {
      const qs = new URLSearchParams({ hash: c.hash, path: f.path });
      if (f.from) qs.set('from', f.from);
      return api('GET', projectUrl(project, `/git/commit-diff?${qs}`)).then((r) => r.text);
    };
    // File bị xóa trong commit thì xem bản ngay trước đó.
    const rev = f.status === 'D' ? data.base : c.hash;
    const open = (mode) => openViewer({ project, path: f.path, rev, diff, mode });
    list.append(fileRow(f.status, XY_LABEL[f.status] || f.status, f.from ? `${f.from} → ${f.path}` : f.path, open));
  }
}

// ---------- Nhánh ----------

async function openBranches() {
  if (!project) return;
  const list = $('#branch-list');
  $('#branch-error').textContent = '';
  branchForm.name.value = '';
  list.replaceChildren(el('li', { class: 'muted', text: 'Đang tải…' }));
  dlgBranch.showModal();
  let data;
  try {
    data = await api('GET', projectUrl(project, '/git/branches'));
  } catch (err) {
    $('#branch-error').textContent = err.message;
    list.replaceChildren();
    return;
  }
  const item = (name, current, hint) => el('li', {}, el('button', {
    type: 'button',
    class: current ? 'current' : '',
    disabled: current,
    onclick: () => switchBranch(name, false),
  }, el('span', { class: 'ico ico-branch' }), el('span', { class: 'ellipsis grow', text: name }), hint ? el('span', { class: 'muted small', text: hint }) : null));
  list.replaceChildren(el('li', { class: 'group', text: 'Nhánh local' }));
  for (const b of data.local) list.append(item(b.name, b.name === data.current, b.name === data.current ? 'đang dùng' : b.upstream || ''));
  if (!data.local.length) list.append(el('li', { class: 'muted small', text: 'Chưa có nhánh (chưa có commit).' }));
  if (data.remote.length) {
    list.append(el('li', { class: 'group', text: 'Trên remote (tạo nhánh local theo dõi)' }));
    for (const r of data.remote) list.append(item(r, false, ''));
  }
}

async function switchBranch(name, create) {
  $('#branch-error').textContent = '';
  try {
    await api('POST', projectUrl(project, '/git/checkout'), { branch: name, create });
    dlgBranch.close();
    toast(create ? `Đã tạo nhánh ${name}` : `Đã chuyển sang ${name}`);
  } catch (err) {
    $('#branch-error').textContent = err.message;
    return;
  }
  commit = null;
  if (view === 'commit') setView('log');
  await load();
  if (autoSyncBox.checked) syncOnEnter();
}

// ---------- Fetch / pull / push ----------

function setRunning(on) {
  running = on;
  document.querySelectorAll('[data-git]').forEach((b) => { b.disabled = on; });
}

async function runRemote(op) {
  if (running || !project) return;
  setRunning(true);
  try {
    const { job } = await api('POST', projectUrl(project, `/git/${op}`));
    const done = await followJob(job, jobEl);
    toast(done.status === 'ok' ? `git ${op} xong` : `git ${op} lỗi, xem chi tiết bên dưới`, done.status === 'ok' ? '' : 'error');
    if (op === 'push' && done.status === 'ok') pushTried = null;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setRunning(false);
    load();
  }
}

// Lệnh chạy ngầm khi tự đồng bộ: chỉ hiện output khi lỗi.
async function quietJob(op) {
  const current = project;
  setRunning(true);
  try {
    const { job } = await api('POST', projectUrl(current, `/git/${op}`));
    const done = await followJob(job, null);
    if (done.status !== 'ok' && current === project) {
      jobEl.hidden = false;
      jobEl.textContent = `$ git ${op} (tự đồng bộ)\n${done.output.trim()}`;
      toast(`Tự đồng bộ: git ${op} lỗi`, 'error');
    }
    return done.status === 'ok';
  } catch (err) {
    if (current === project) toast(`Tự đồng bộ: ${err.message}`, 'error');
    return false;
  } finally {
    setRunning(false);
  }
}

async function fetchStatus() {
  const current = project;
  const st = await api('GET', projectUrl(current, '/git/status')).catch(() => null);
  if (!st || current !== project) return null;
  // Chỉ vẽ lại khi có gì đổi, để danh sách không nháy/nhảy khi đang bấm.
  if (JSON.stringify(st) !== JSON.stringify(lastStatus)) render(st);
  return st;
}

function note(text, st) {
  syncNote = text;
  if (st) renderInfo(st);
}

function startAutoSync() {
  stopAutoSync();
  pushTried = null;
  syncOnEnter();
  syncTimer = setInterval(syncTick, SYNC_EVERY_MS);
}

function stopAutoSync() {
  clearInterval(syncTimer);
  syncTimer = null;
}

// Vừa vào dự án (hoặc vừa bật/đổi nhánh): fetch, pull nếu fast-forward được, rồi push nếu có commit mới.
async function syncOnEnter() {
  if (syncing || running) return;
  syncing = true;
  const current = project;
  try {
    let st = await fetchStatus();
    if (!st?.repo || !st.remote) return note(st?.repo ? 'chưa có remote origin' : '', st);
    if (!st.upstream) return note('nhánh chưa có trên remote, bấm Push lần đầu', st);
    if (!(await quietJob('fetch')) || current !== project) return;
    st = await fetchStatus();
    if (!st) return;
    if (st.behind && st.ahead) return note(`nhánh đã tách (↑${st.ahead} ↓${st.behind}), cần xử lý tay`, st);
    if (st.behind) {
      if (await quietJob('pull')) {
        toast(`Đã tự pull ${st.behind} commit`);
        note(`đã pull lúc ${new Date().toLocaleTimeString()}`);
        load();
      }
      return;
    }
    note(`đã kiểm tra lúc ${new Date().toLocaleTimeString()}`, st);
  } finally {
    syncing = false;
  }
  syncTick();
}

// Định kỳ: có commit mới (của mình hoặc Claude) mà chưa push thì push ngay.
async function syncTick() {
  if (!syncTimer || syncing || running || document.visibilityState !== 'visible') return;
  syncing = true;
  try {
    const st = await fetchStatus();
    if (!st?.repo || !st.upstream) return;
    if (st.ahead && st.behind) return note(`nhánh đã tách (↑${st.ahead} ↓${st.behind}), cần xử lý tay`, st);
    if (!st.ahead || st.behind || st.head === pushTried) return;
    pushTried = st.head;
    if (await quietJob('push')) {
      toast(`Đã tự push ${st.ahead} commit`);
      note(`đã push lúc ${new Date().toLocaleTimeString()}`);
    } else {
      // Push bị từ chối thường do remote có commit mới: fetch để biết có pull được không.
      await quietJob('fetch');
      note('push lỗi, xem chi tiết');
    }
    load();
  } finally {
    syncing = false;
  }
}
