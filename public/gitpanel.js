// Panel git của dự án: nhánh, thay đổi, commit, lịch sử, fetch/pull/push, tự đồng bộ và khóa dự án khi đang pull/xử lý xung đột.

import { $, el, api, projectUrl, timeAgo, toast, showText, followJob } from './common.js';
import { openViewer } from './viewer.js';
import { accounts, aliasUrl, urlHost, fillAccountSelect } from './gitaccounts.js';

const infoEl = $('#git-info');
const changesEl = $('#git-changes');
const logEl = $('#git-log');
const jobEl = $('#git-job');
const jobBox = $('#git-job-box'); // khung log fetch/pull/push, có nút ✕ để ẩn
const repoEl = $('#git-repo');
const noRepoEl = $('#git-norepo');
const commitForm = $('#git-commit-form');
const autoSyncBox = $('#git-autosync');
const dlgBranch = $('#dlg-branch');
const branchForm = $('#branch-form');
const dlgRemote = $('#dlg-remote');
const remoteForm = $('#remote-form');

const lockEl = $('#project-lock');

const SYNC_EVERY_MS = 10000;
const WATCH_MS = 5000; // xem khóa/trạng thái git kể cả khi không tự đồng bộ (máy khác đang pull, Claude đang xử lý)
const LOCK_WATCH_MS = 2000;
const SESSION_STATE = { busy: 'Claude đang xử lý…', sent: 'Claude đang xử lý…', idle: 'Claude đã dừng nhưng merge chưa xong, mở phiên xem giúp', waiting: 'Claude đang chờ anh cho phép, mở phiên để duyệt', ended: 'Phiên Claude đã thoát, merge chưa xong' };
const XY_LABEL = { M: 'sửa', A: 'thêm', D: 'xóa', R: 'đổi tên', C: 'chép', U: 'xung đột', T: 'đổi loại' };

let project = null;
let running = false; // đang chạy fetch/pull/push (bấm tay hoặc tự đồng bộ)
let view = 'changes';
let commit = null; // commit đang xem chi tiết
let lastStatus = null;

// Tự đồng bộ: mặc định (bật/tắt) chỉnh trong ⚙ Cài đặt Git. Mặc định tắt thì mỗi lần vào dự án là tắt, đổi nhánh
// cũng tự tắt; mặc định bật thì vào dự án hay đổi nhánh đều tự bật cho nhánh mới.
// Bật lên thì pull một lần (merge, xung đột thì giao Claude xử lý và khóa dự án), sau đó có commit mới là push,
// không bao giờ tự commit.
let autoSyncDefault = false;
const settingsReady = api('GET', '/api/git/config').then((c) => { autoSyncDefault = c.autoSync === true; }, () => {});
let openSession = () => {};
let watchTimer = null;
let lockShown = null; // khóa đang hiện, để không vẽ lại liên tục
let lockFull = true; // false: anh đã bấm mở phiên Claude, chỉ còn thanh báo nhỏ
let syncTimer = null;
let syncBranch = null; // nhánh lúc bật tự đồng bộ
let syncing = false;
let pushTried = null; // HEAD đã thử tự push, để push lỗi thì không thử lại mãi
let pullTried = null; // như trên cho pull lỗi (không phải xung đột)
let syncNote = '';

export function initGit(opts = {}) {
  openSession = opts.openSession || openSession;
  initRemote();
  $('#lock-open').addEventListener('click', () => {
    lockFull = false;
    renderLock(lastStatus);
    if (lastStatus?.lock?.session) openSession(lastStatus.lock.session);
  });
  $('#lock-resolve').addEventListener('click', () => askClaude());
  $('#lock-release').addEventListener('click', async () => {
    try {
      await api('DELETE', projectUrl(project, '/git/lock'));
    } catch (err) {
      toast(err.message, 'error');
    }
    fetchStatus();
  });
  $('#git-refresh').addEventListener('click', () => load());
  $('#git-job-close').addEventListener('click', () => { jobBox.hidden = true; });
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
    syncBranch = lastStatus?.branch ?? null;
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

// Lưu cài đặt git xong (app.js): áp dụng mặc định mới cho các lần vào dự án/đổi nhánh sau.
export function setAutoSyncDefault(on) {
  autoSyncDefault = on;
}

export function getAutoSyncDefault() {
  return autoSyncDefault;
}

export async function setGitProject(name) {
  if (project === name) return;
  stopAutoSync();
  clearTimeout(watchTimer);
  watchTimer = null;
  lockShown = null;
  lockFull = true;
  renderLock(null);
  project = name;
  jobBox.hidden = true;
  infoEl.replaceChildren();
  changesEl.replaceChildren();
  logEl.replaceChildren();
  commit = null;
  lastStatus = null;
  syncNote = '';
  pushTried = null;
  pullTried = null;
  if (view === 'commit') view = 'log';
  showView();
  turnOffSync();
  if (!name) return;
  watch();
  await settingsReady;
  if (project === name && autoSyncDefault) turnOnSync();
}

function turnOnSync() {
  autoSyncBox.checked = true;
  syncBranch = null;
  syncNote = '';
  startAutoSync();
}

// Xem trạng thái git định kỳ: thấy khóa (máy khác đang pull, Claude đang xử lý xung đột) để khóa giao diện.
function watch() {
  clearTimeout(watchTimer);
  const current = project;
  watchTimer = setTimeout(async () => {
    if (current !== project) return;
    if (document.visibilityState === 'visible' && !syncing) await fetchStatus();
    if (current === project) watch();
  }, lastStatus?.lock ? LOCK_WATCH_MS : WATCH_MS);
}

function turnOffSync() {
  stopAutoSync();
  autoSyncBox.checked = false;
  syncBranch = null;
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
  // Nhánh đổi (bấm đổi nhánh, hoặc Claude/terminal checkout): mặc định tắt thì tắt tự đồng bộ,
  // mặc định bật thì đồng bộ luôn nhánh mới.
  if (autoSyncBox.checked) {
    if (syncBranch == null) syncBranch = st.branch;
    else if (st.branch !== syncBranch) {
      if (autoSyncDefault) {
        toast(`Đã đổi sang nhánh ${st.branch || '?'}, tự đồng bộ nhánh này`);
        setTimeout(turnOnSync);
      } else {
        turnOffSync();
        toast(`Đã đổi sang nhánh ${st.branch || '?'}, tắt tự đồng bộ`);
      }
    }
  }
  const wasLocked = !!lastStatus?.lock;
  lastStatus = st;
  renderLock(st);
  // Claude merge xong (hết khóa): push ngay, không chờ vòng sau.
  if (wasLocked && !st.lock && !st.merging && autoSyncBox.checked) {
    note('đã xử lý xong xung đột');
    setTimeout(syncTick);
  }
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
    el('div', { class: 'git-remote' },
      el('span', { class: 'muted small ellipsis', title: st.remote || '', text: st.remote ? `origin: ${st.remote}` : 'Chưa có remote origin' }),
      el('button', { type: 'button', class: 'icon-btn small', title: st.remote ? 'Đổi remote origin' : 'Thêm remote origin', 'aria-label': 'Đổi remote origin', text: '✎', onclick: () => openRemote(st.remote || '') })),
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
  if (autoSyncDefault && autoSyncBox.checked) turnOnSync();
  else turnOffSync();
  await load();
}

// ---------- Fetch / pull / push ----------

function setRunning(on) {
  running = on;
  updateDisabled();
}

function updateDisabled() {
  const locked = !!lastStatus?.lock;
  document.querySelectorAll('[data-git]').forEach((b) => { b.disabled = running || locked; });
  $('#git-branch').disabled = locked;
  autoSyncBox.disabled = locked;
  commitForm.querySelectorAll('button, textarea, input').forEach((x) => { x.disabled = locked; });
}

// ---------- Khóa dự án: đang pull, hoặc Claude đang xử lý xung đột merge ----------

async function renderLock(st) {
  updateDisabled();
  const lock = st?.lock || null;
  // Còn merge dở có xung đột mà không ai xử lý (vd restart server, hoặc merge tay): chỉ báo, cho bấm giao Claude.
  const orphan = !lock && st?.merging && st.changes.some((c) => c.conflict);
  const key = lock ? `${lock.kind}:${lock.session || ''}:${lockFull}` : orphan ? 'orphan' : null;
  if (!key) {
    lockEl.hidden = true;
    lockShown = null;
    lockFull = true;
    return;
  }
  let text;
  if (lock?.kind === 'pull') text = 'Đang tự pull từ remote, dự án tạm khóa…';
  else if (lock) {
    const s = await api('GET', projectUrl(project, '/sessions')).then((r) => r.sessions.find((x) => x.name === lock.session), () => null);
    text = `Xung đột khi pull, đang giao Claude xử lý (phiên “Xử lý xung đột”). ${s ? SESSION_STATE[s.state] || 'Claude đang khởi động…' : SESSION_STATE.ended}`;
  } else text = 'Nhánh đang merge dở và còn xung đột. Giao Claude xử lý, hoặc tự xử lý trong terminal rồi commit.';
  lockEl.hidden = false;
  lockEl.classList.toggle('full', !!lock && lockFull);
  $('#lock-text').textContent = text;
  $('#lock-spin').hidden = !lock;
  $('#lock-open').hidden = !lock?.session || !lockFull;
  $('#lock-resolve').hidden = !orphan;
  $('#lock-release').hidden = lock?.kind !== 'conflict';
  if (lockShown !== key && lock?.kind === 'conflict' && lockShown?.startsWith('pull')) toast('Pull bị xung đột, đã giao Claude xử lý', 'error');
  lockShown = key;
}

// Giao xung đột cho Claude: server mở phiên Claude riêng, gửi prompt xử lý, khóa dự án tới khi merge xong.
async function askClaude() {
  const current = project;
  try {
    const { session } = await api('POST', projectUrl(current, '/git/resolve'));
    if (current !== project) return;
    toast('Pull bị xung đột, đã giao Claude xử lý');
    lockFull = true;
    note('xung đột khi pull, Claude đang xử lý');
    await fetchStatus();
    return session;
  } catch (err) {
    if (current === project) toast(`Giao Claude xử lý xung đột lỗi: ${err.message}`, 'error');
  }
}

async function runRemote(op) {
  if (running || !project) return;
  setRunning(true);
  try {
    const { job } = await api('POST', projectUrl(project, `/git/${op}`));
    jobBox.hidden = false;
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
      jobBox.hidden = false;
      const cmd = op === 'sync' ? 'pull' : op;
      jobEl.textContent = `$ git ${cmd} (tự đồng bộ)\n${done.output.trim()}`;
      if (!(op === 'sync' && /CONFLICT|conflict/.test(done.output))) toast(`Tự đồng bộ: git ${cmd} lỗi`, 'error');
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
  pullTried = null;
  syncOnEnter();
  syncTimer = setInterval(syncTick, SYNC_EVERY_MS);
}

function stopAutoSync() {
  clearInterval(syncTimer);
  syncTimer = null;
}

// Vừa bật tự đồng bộ (hoặc vừa vào dự án khi mặc định bật): fetch, pull (merge), rồi push nếu có commit mới.
async function syncOnEnter() {
  if (syncing || running) return;
  syncing = true;
  const current = project;
  try {
    let st = await fetchStatus();
    if (!st?.repo || !st.remote) return note(st?.repo ? 'chưa có remote origin' : '', st);
    if (!st.upstream) return note('nhánh chưa có trên remote, bấm Push lần đầu', st);
    if (st.lock || st.merging) return note(st.lock ? 'dự án đang khóa' : 'đang merge dở, chờ xử lý xung đột', st);
    if (!(await quietJob('fetch')) || current !== project || !syncTimer) return;
    st = await fetchStatus();
    if (!st || !syncTimer) return;
    if (st.behind && !(await pullNow(st))) return;
    if (!st.behind) note(`đã kiểm tra lúc ${new Date().toLocaleTimeString()}`, st);
  } finally {
    syncing = false;
  }
  syncTick();
}

// Pull kiểu merge (server khóa dự án trong lúc pull). Xung đột thì giao Claude. Trả về true nếu pull xong không xung đột.
async function pullNow(st) {
  const current = project;
  const ok = await quietJob('sync');
  if (current !== project) return false;
  const after = await fetchStatus();
  if (after?.merging) {
    await askClaude();
    return false;
  }
  if (!ok) {
    pullTried = after?.head ?? st.head; // vd file chưa commit chặn pull: chờ HEAD đổi mới thử lại
    note('pull lỗi, xem chi tiết', after);
    return false;
  }
  toast(`Đã tự pull ${st.behind} commit`);
  note(`đã pull lúc ${new Date().toLocaleTimeString()}`, after);
  load();
  return true;
}

// Định kỳ: có commit mới (của mình hoặc Claude) mà chưa push thì push ngay.
async function syncTick() {
  if (!syncTimer || syncing || running || document.visibilityState !== 'visible') return;
  syncing = true;
  try {
    const st = await fetchStatus();
    if (!syncTimer || !st?.repo || !st.upstream) return; // vừa đổi nhánh thì đã tắt
    if (st.lock || st.merging) return;
    // Remote có commit mới (biết được sau khi push bị từ chối rồi fetch): pull về trước, lần sau mới push.
    if (st.behind) {
      if (st.head !== pullTried) await pullNow(st);
      return;
    }
    if (!st.ahead || st.head === pushTried) return;
    pushTried = st.head;
    if (await quietJob('push')) {
      toast(`Đã tự push ${st.ahead} commit`);
      note(`đã push lúc ${new Date().toLocaleTimeString()}`);
    } else {
      // Push bị từ chối thường do remote có commit mới: fetch, vòng sau thấy behind thì pull (merge) rồi push lại.
      await quietJob('fetch');
      note('push lỗi, xem chi tiết');
    }
    load();
  } finally {
    syncing = false;
  }
}

// ---------- Đổi remote origin (chọn tài khoản thì URL đi qua alias SSH của tài khoản đó) ----------

let remoteAccounts = [];

async function openRemote(url) {
  remoteForm.url.value = url;
  $('#remote-error').textContent = '';
  dlgRemote.showModal();
  try {
    remoteAccounts = await accounts();
  } catch {
    remoteAccounts = [];
  }
  fillAccountSelect(remoteForm.account, remoteAccounts, { none: 'Theo URL', value: urlHost(url) });
}

function initRemote() {
  remoteForm.account.addEventListener('change', () => {
    const acc = remoteAccounts.find((a) => a.alias === remoteForm.account.value);
    if (acc && remoteForm.url.value.trim()) remoteForm.url.value = aliasUrl(remoteForm.url.value, acc);
  });
  remoteForm.url.addEventListener('input', () => {
    const host = urlHost(remoteForm.url.value);
    remoteForm.account.value = remoteAccounts.some((a) => a.alias === host) ? host : '';
  });
  remoteForm.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      const r = await api('POST', projectUrl(project, '/git/remote'), { url: remoteForm.url.value.trim() });
      dlgRemote.close();
      toast(`origin: ${r.remote}`);
      load();
    } catch (err) {
      $('#remote-error').textContent = err.message;
    }
  });
}
