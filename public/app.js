// Màn chính: chọn dự án -> làm việc trong dự án (nhiều tab terminal, panel File/Git).

/* global Terminal, FitAddon */

import { $, el, api, store, projectUrl, timeAgo, toast, confirmDialog, inputDialog, followJob, isTouch, isNarrow, nativeApp, copyText } from './common.js';
import { attachTouch } from './touchterm.js';
import { initFiles, setFilesProject, load as loadFiles, download } from './files.js';
import { initPreview, setPreviewProject, openPreview, togglePreview } from './preview.js';
import { initSketch, openSketch } from './sketch.js';
import { initSlash } from './slash.js';
import { renderAnsi } from './ansi.js';
import { initGit, setGitProject, setAutoSyncDefault, load as loadGit } from './gitpanel.js';
import { openBrowser } from './browserview.js';
import { initShortcuts, openShortcuts, shortcutLabel } from './shortcuts.js';
import { accounts as gitAccounts, checkAccount, aliasUrl, urlHost, fillAccountSelect, whoText, renderAccounts, initGitAccounts } from './gitaccounts.js';

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
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path?.toLowerCase().includes(q))
    .sort((a, b) => (b.sessions ? 1 : 0) - (a.sessions ? 1 : 0) || (recent[b.name] || 0) - (recent[a.name] || 0) || a.name.localeCompare(b.name));
  listEl.replaceChildren();
  if (!items.length) {
    listEl.append(el('li', { class: 'muted pad', text: projectList.length ? 'Không có dự án khớp.' : 'Chưa có dự án nào. Bấm "＋ Dự án mới" để tạo hoặc clone.' }));
    return;
  }
  for (const p of items) {
    const meta = [
      p.missing ? 'không tìm thấy thư mục' : p.git ? p.branch || 'git' : 'không có git',
      p.sessions ? `${p.sessions} phiên đang chạy` : '',
      recent[p.name] ? `mở ${timeAgo(recent[p.name])}` : '',
    ].filter(Boolean).join(' · ');
    listEl.append(el('li', {}, el('a', { class: 'project-card', href: `#/p/${encodeURIComponent(p.name)}` },
      el('span', { class: 'project-name', text: p.name }),
      el('span', { class: 'project-meta' }, p.git ? el('span', { class: 'ico ico-branch' }) : null, meta),
      p.linked ? el('span', { class: 'project-path', text: p.path }) : null,
      p.sessions ? el('span', { class: 'dot', title: 'Có phiên đang chạy' }) : null)));
  }
}

$('#project-filter').addEventListener('input', renderProjects);

// Duyệt thư mục trên server để mở một thư mục bất kỳ làm dự án (thư mục con có git, thư mục ngoài…).
const dlgBrowse = $('#dlg-browse');
const browsePath = $('#browse-path');
let browsing = null; // kết quả /api/browse đang hiển thị

async function browseTo(target) {
  $('#browse-error').textContent = '';
  $('#browse-recent').classList.remove('active');
  try {
    const hidden = $('#browse-hidden').checked ? '1' : '0';
    browsing = await api('GET', `/api/browse?path=${encodeURIComponent(target)}&hidden=${hidden}`);
  } catch (err) {
    $('#browse-error').textContent = err.message;
    return;
  }
  store.set('cpm.browsePath', browsing.path);
  browsePath.value = browsing.path;
  $('#browse-up').disabled = !browsing.parent;
  const join = (name) => (browsing.path.endsWith('/') ? browsing.path : `${browsing.path}/`) + name;
  $('#browse-list').replaceChildren(...(browsing.dirs.length
    ? browsing.dirs.map((d) => el('li', {}, el('button', { type: 'button', class: 'browse-item', onclick: () => browseTo(join(d.name)) },
      d.git ? el('span', { class: 'ico ico-branch', title: 'Có git' }) : el('span', { class: 'browse-ico', text: '📁' }),
      d.name)))
    : [el('li', { class: 'muted pad', text: 'Không có thư mục con.' })]));
}

// Danh sách thư mục đã mở thêm (data/projects.json), mới mở gần nhất lên đầu; ✕ bỏ khỏi danh sách.
async function showRecentFolders() {
  $('#browse-error').textContent = '';
  let items;
  try {
    ({ projects: items } = await api('GET', '/api/projects/linked'));
  } catch (err) {
    $('#browse-error').textContent = err.message;
    return;
  }
  $('#browse-recent').classList.add('active');
  const recent = store.get('cpm.recent', {});
  items.sort((a, b) => (b.sessions ? 1 : 0) - (a.sessions ? 1 : 0) || (recent[b.name] || 0) - (recent[a.name] || 0) || a.name.localeCompare(b.name));
  $('#browse-list').replaceChildren(...(items.length
    ? items.map((p) => el('li', { class: 'browse-row' },
      el('button', { type: 'button', class: 'browse-item', disabled: p.missing, onclick: () => openRecentFolder(p) },
        p.git ? el('span', { class: 'ico ico-branch', title: 'Có git' }) : el('span', { class: 'browse-ico', text: '📁' }),
        el('span', { class: 'browse-recent-text' },
          el('span', { text: p.name }),
          el('span', { class: 'project-path', text: [p.path, p.missing ? 'không tìm thấy thư mục' : '', p.sessions ? `${p.sessions} phiên đang chạy` : '', recent[p.name] ? `mở ${timeAgo(recent[p.name])}` : ''].filter(Boolean).join(' · ') }))),
      el('button', { type: 'button', class: 'icon-btn small', title: 'Bỏ khỏi danh sách (không xóa thư mục)', 'aria-label': 'Bỏ khỏi danh sách', text: '✕', onclick: () => unlinkFolder(p) })))
    : [el('li', { class: 'muted pad', text: 'Chưa mở thư mục nào.' })]));
}

function openRecentFolder(p) {
  dlgBrowse.close();
  location.hash = `#/p/${encodeURIComponent(p.name)}`;
}

async function unlinkFolder(p) {
  if (!(await confirmDialog(`Bỏ "${p.name}" khỏi danh sách gần đây?\n${p.path}\nThư mục trên server vẫn giữ nguyên.`, 'Bỏ'))) return;
  try {
    await api('DELETE', `/api/projects/${encodeURIComponent(p.name)}/link`);
  } catch (err) {
    $('#browse-error').textContent = err.message;
    return;
  }
  showRecentFolders();
}

$('#btn-open-folder').addEventListener('click', () => {
  dlgBrowse.showModal();
  browseTo(store.get('cpm.browsePath', ''));
});
$('#browse-up').addEventListener('click', () => browsing?.parent && browseTo(browsing.parent));
$('#browse-home').addEventListener('click', () => browseTo('~'));
$('#browse-root').addEventListener('click', () => browseTo(''));
$('#browse-recent').addEventListener('click', showRecentFolders);
$('#browse-hidden').addEventListener('change', () => browseTo(browsing?.path || ''));
$('#browse-form').addEventListener('submit', async (e) => {
  const action = e.submitter?.value;
  if (action === 'cancel') return;
  e.preventDefault();
  if (action !== 'open') return browseTo(browsePath.value); // Enter trong ô đường dẫn hoặc nút Đi
  try {
    const { name } = await api('POST', '/api/projects/open', { path: browsing?.path || browsePath.value });
    dlgBrowse.close();
    location.hash = `#/p/${encodeURIComponent(name)}`;
  } catch (err) {
    $('#browse-error').textContent = err.message;
  }
});

// ---------- Thanh tài nguyên server (RAM, disk) dưới thanh tab ----------
const statbar = $('#statbar');
const fmtBytes = (n) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;

function statMeter(used, total) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  const m = el('span', { class: `meter${pct >= 90 ? ' bad' : pct >= 75 ? ' warn' : ''}` });
  const bar = el('i');
  bar.style.width = `${pct}%`;
  m.append(bar);
  return m;
}

function statItem(label, value, title, meter) {
  const it = el('span', { class: 'st', title });
  it.append(label);
  if (meter) it.append(meter);
  it.append(el('b', { text: value }));
  return it;
}

function renderStats(s) {
  const { ram, disk, user } = s;
  const items = [
    statItem('RAM', `${fmtBytes(ram.used)}/${fmtBytes(ram.total)}`, `RAM server đã dùng ${Math.round((ram.used / ram.total) * 100)}% (không tính cache)`, statMeter(ram.used, ram.total)),
  ];
  if (ram.user) items.push(statItem(user, fmtBytes(ram.user), `RAM các tiến trình của ${user} (cộng RSS, gần đúng)`));
  items.push(statItem('App', fmtBytes(ram.app), 'RAM của app này (server node + Chromium/tiến trình con)'));
  if (ram.claude) items.push(statItem('Claude', fmtBytes(ram.claude), 'RAM các phiên Claude đang chạy trong tmux'));
  if (disk) {
    items.push(el('span', { class: 'sep' }));
    items.push(statItem('Disk', `${fmtBytes(disk.used)}/${fmtBytes(disk.total)}`, `Ổ chứa dự án: còn trống ${fmtBytes(disk.free)}`, statMeter(disk.used, disk.total)));
    items.push(statItem(user, disk.user == null ? '…' : fmtBytes(disk.user), disk.user == null ? `Đang tính dung lượng ${disk.home}…` : `Dung lượng thư mục ${disk.home} (tính lại mỗi 10 phút)`));
  }
  statbar.replaceChildren(...items);
}

async function pollStats() {
  if (!viewWorkspace.hidden && document.visibilityState === 'visible') {
    try {
      renderStats(await api('GET', '/api/stats'));
    } catch {
      // mất kết nối thì giữ số cũ
    }
  }
  setTimeout(pollStats, 5000);
}
pollStats();
new MutationObserver(() => !viewWorkspace.hidden && api('GET', '/api/stats').then(renderStats, () => {})).observe(viewWorkspace, { attributes: true, attributeFilter: ['hidden'] });

// Tạo dự án: thư mục trống (không git), clone từ URL, tạo repo mới trên GitHub qua một tài khoản rồi clone về,
// hoặc upload một thư mục / file .zip từ máy.
const dlgProject = $('#dlg-project');
const projectForm = $('#project-form');
const projectNote = $('#project-note');
let autoName = true;
let ownerTouched = false;
let accountList = [];

const projectMode = () => projectForm.querySelector('input[name="mode"]:checked').value;

$('#btn-new-project').addEventListener('click', async () => {
  projectForm.reset();
  autoName = true;
  ownerTouched = false;
  $('#project-error').textContent = '';
  $('#project-job').hidden = true;
  setProjectFormBusy(false);
  uploadPick = null;
  showProjectMode();
  dlgProject.showModal();
  try {
    accountList = await gitAccounts();
  } catch {
    accountList = [];
  }
  fillAccountSelect(projectForm.cloneAccount, accountList, { none: 'Theo URL' });
  fillAccountSelect(projectForm.account, accountList.filter((a) => a.keyExists), { value: store.get('cpm.newRepoAccount', '') });
  updateProjectNote();
});

function showProjectMode() {
  const mode = projectMode();
  $('#pm-clone').hidden = mode !== 'clone';
  $('#pm-create').hidden = mode !== 'create';
  $('#pm-upload').hidden = mode !== 'upload';
  projectForm.querySelector('button[value="ok"]').textContent = mode === 'upload' ? 'Upload' : 'Tạo';
  updateProjectNote();
}

const cloneAccount = () => accountList.find((a) => a.alias === projectForm.cloneAccount.value);
const cloneUrl = () => aliasUrl(projectForm.gitUrl.value, cloneAccount());

async function updateProjectNote() {
  const mode = projectMode();
  if (mode === 'empty') {
    projectNote.textContent = 'Chỉ tạo thư mục, chưa có git (vào panel Git bấm git init khi cần).';
    return;
  }
  if (mode === 'upload') {
    projectNote.textContent = uploadSummary();
    return;
  }
  if (mode === 'clone') {
    const url = cloneUrl();
    projectNote.textContent = url && url !== projectForm.gitUrl.value.trim() ? `Clone bằng: ${url}` : '';
    return;
  }
  const alias = projectForm.account.value;
  if (!alias) {
    projectNote.textContent = 'Chưa có tài khoản nào có key. Thêm trong ⚙ Cài đặt Git.';
    return;
  }
  projectNote.textContent = `${alias}: đang dò tài khoản…`;
  let info;
  try {
    info = await checkAccount(alias);
  } catch (err) {
    info = { message: err.message };
  }
  if (projectForm.account.value !== alias || projectMode() !== 'create') return;
  if (info.login && !ownerTouched) projectForm.owner.value = info.login;
  const name = projectForm.name.value.trim() || '<tên>';
  projectNote.textContent = !info.login ? `${alias}: ${whoText(info)}`
    : info.provider !== 'github' ? 'Tạo repo mới hiện chỉ hỗ trợ GitHub.'
    : `${whoText(info)}. Sẽ tạo github.com/${projectForm.owner.value.trim() || info.login}/${name} rồi clone về.`;
}

projectForm.addEventListener('change', (e) => {
  if (e.target.name === 'mode') showProjectMode();
  else if (['account', 'cloneAccount', 'private', 'skipJunk'].includes(e.target.name)) updateProjectNote();
});
projectForm.gitUrl.addEventListener('input', () => {
  // Dán URL có host trùng alias nào thì chọn sẵn tài khoản đó.
  const host = urlHost(projectForm.gitUrl.value);
  if (accountList.some((a) => a.alias === host)) projectForm.cloneAccount.value = host;
  updateProjectNote();
  if (!autoName) return;
  const m = projectForm.gitUrl.value.trim().match(/([^/:]+?)(?:\.git)?\/?$/);
  projectForm.name.value = m ? m[1].replace(/[^A-Za-z0-9._-]/g, '-') : '';
});
projectForm.name.addEventListener('input', () => {
  autoName = !projectForm.name.value;
  if (projectMode() === 'create') updateProjectNote();
});
projectForm.owner.addEventListener('input', () => {
  ownerTouched = !!projectForm.owner.value;
  updateProjectNote();
});

// ---- Upload thư mục / zip ----
// Trình duyệt điện thoại (và WebView của app) không chọn được cả thư mục, chỉ chọn được file .zip.
let uploadPick = null; // { kind: 'dir', files: [{ file, path }] } | { kind: 'zip', file }
const dirInput = $('#pm-dir-input');
const zipInput = $('#pm-zip-input');
const canPickDir = 'webkitdirectory' in dirInput && !nativeApp && !/Android|iPhone|iPod/i.test(navigator.userAgent);
$('#pm-pick-dir').hidden = !canPickDir;
$('#pm-skip-wrap').hidden = !canPickDir;
$('#pm-pick-dir').addEventListener('click', () => dirInput.click());
$('#pm-pick-zip').addEventListener('click', () => zipInput.click());

const JUNK_DIRS = new Set(['node_modules', '.venv', '__pycache__']);
const isJunk = (p) => p.split('/').some((seg, i, all) => (i < all.length - 1 && JUNK_DIRS.has(seg)) || seg === '.DS_Store');
const safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
const fmtSize = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function pickedFiles() {
  if (uploadPick?.kind !== 'dir') return [];
  return projectForm.skipJunk.checked ? uploadPick.files.filter((f) => !isJunk(f.path)) : uploadPick.files;
}

function uploadSummary() {
  if (!uploadPick) return canPickDir ? 'Chọn một thư mục trên máy (hoặc file .zip) để đưa lên server thành dự án mới.' : 'Chọn file .zip để giải nén trên server thành dự án mới.';
  if (uploadPick.kind === 'zip') return `${uploadPick.file.name} (${fmtSize(uploadPick.file.size)}), sẽ giải nén trên server. Zip chỉ có một thư mục gốc thì lấy thư mục đó làm dự án.`;
  const list = pickedFiles();
  const skipped = uploadPick.files.length - list.length;
  return `${uploadPick.root}: ${list.length} file, ${fmtSize(list.reduce((n, f) => n + f.file.size, 0))}${skipped ? ` (bỏ qua ${skipped} file)` : ''}.`;
}

function setPickName(base) {
  if (!autoName && projectForm.name.value) return;
  projectForm.name.value = safeName(base);
  autoName = true;
}

dirInput.addEventListener('change', () => {
  const all = [...dirInput.files];
  dirInput.value = '';
  if (!all.length) return;
  // webkitRelativePath = "<thư mục đã chọn>/a/b.txt": bỏ phần đầu để file nằm thẳng trong dự án.
  const root = all[0].webkitRelativePath.split('/')[0];
  const files = all.map((file) => ({ file, path: file.webkitRelativePath.split('/').slice(1).join('/') })).filter((f) => f.path);
  uploadPick = { kind: 'dir', root, files };
  setPickName(root);
  updateProjectNote();
});
zipInput.addEventListener('change', () => {
  const file = zipInput.files[0];
  zipInput.value = '';
  if (!file) return;
  uploadPick = { kind: 'zip', file };
  setPickName(file.name.replace(/\.zip$/i, ''));
  updateProjectNote();
});

// POST body thô, có tiến độ upload. Trả về { status, data }.
function postRaw(url, body, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // nginx trả HTML khi vượt giới hạn
      }
      if (xhr.status === 401) location.href = '/login';
      if (xhr.status >= 300) data.error ||= xhr.status === 413 ? 'File quá lớn so với giới hạn của server' : `Lỗi ${xhr.status}`;
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ status: 0, data: { error: 'Mất kết nối' } });
    xhr.send(body);
  });
}

async function uploadZip(name, file) {
  const r = await postRaw(`/api/projects/import-zip?name=${encodeURIComponent(name)}`, file, (done, total) => {
    projectNote.textContent = done < total ? `Đang upload ${file.name}: ${Math.round((done / total) * 100)}%` : 'Đang giải nén trên server…';
  });
  if (r.status !== 201) throw new Error(r.data.error);
}

async function uploadDir(name, list) {
  if (!list.length) throw new Error('Thư mục không có file nào để upload');
  await api('POST', '/api/projects', { name });
  const total = list.reduce((n, f) => n + f.file.size, 0);
  const loaded = new Map();
  let doneCount = 0;
  const failed = [];
  const show = () => {
    const bytes = [...loaded.values()].reduce((a, b) => a + b, 0);
    projectNote.textContent = `Đang upload ${doneCount}/${list.length} file (${total ? Math.round((bytes / total) * 100) : 100}%)…`;
  };
  show();
  let next = 0;
  // Gửi song song vài file một lúc cho nhanh, mỗi file một request (không vướng giới hạn kích thước request của nginx).
  const worker = async () => {
    while (next < list.length) {
      const f = list[next++];
      const i = f.path.lastIndexOf('/');
      const qs = new URLSearchParams({ path: i < 0 ? '' : f.path.slice(0, i), name: f.path.slice(i + 1), mkdirs: '1' });
      const r = await postRaw(projectUrl(name, `/upload?${qs}`), f.file, (done) => {
        loaded.set(f, done);
        show();
      });
      loaded.set(f, f.file.size);
      doneCount++;
      if (r.status !== 201) failed.push(`${f.path}: ${r.data.error}`);
      show();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  if (failed.length) {
    $('#project-job').textContent = failed.join('\n');
    $('#project-job').hidden = false;
    throw new Error(`Đã tạo dự án "${name}" nhưng ${failed.length}/${list.length} file upload lỗi (xem ở trên).`);
  }
}

function setProjectFormBusy(busy) {
  for (const b of projectForm.querySelectorAll('button, input, select')) b.disabled = busy;
}

projectForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const name = projectForm.name.value.trim();
  const mode = projectMode();
  const body = { name };
  if (mode === 'clone') {
    if (!projectForm.gitUrl.value.trim()) return projectForm.gitUrl.focus();
    body.gitUrl = cloneUrl();
  } else if (mode === 'upload') {
    if (!uploadPick) return $('#pm-pick-dir').hidden ? $('#pm-pick-zip').click() : $('#pm-pick-dir').click();
  } else if (mode === 'create') {
    if (!projectForm.account.value) return;
    body.repo = { alias: projectForm.account.value, owner: projectForm.owner.value.trim() || undefined, private: projectForm.private.checked };
    store.set('cpm.newRepoAccount', projectForm.account.value);
  }
  $('#project-error').textContent = '';
  setProjectFormBusy(true);
  try {
    if (mode === 'upload') {
      if (uploadPick.kind === 'zip') await uploadZip(name, uploadPick.file);
      else await uploadDir(name, pickedFiles());
      dlgProject.close();
      location.hash = `#/p/${encodeURIComponent(name)}`;
      return;
    }
    const res = await api('POST', '/api/projects', body);
    if (res.job) {
      const job = await followJob(res.job, $('#project-job'));
      if (job.status !== 'ok') {
        throw new Error(mode === 'create'
          ? `Đã tạo repo ${res.url} nhưng clone lỗi, xem chi tiết ở trên. Kiểm tra public key của tài khoản trong ⚙ Cài đặt Git.`
          : 'Clone lỗi, xem chi tiết ở trên. Nếu là repo private qua SSH, kiểm tra tài khoản SSH trong ⚙ Cài đặt Git.');
      }
    }
    dlgProject.close();
    location.hash = `#/p/${encodeURIComponent(name)}`;
  } catch (err) {
    $('#project-error').textContent = err.message;
  } finally {
    setProjectFormBusy(false);
  }
});

// Cài đặt git chung: tên/email để commit, tài khoản SSH để clone/push.
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
  gitForm.autoSync.checked = cfg.autoSync;
  renderAccounts();
}

$('#btn-git-settings').addEventListener('click', openGitSettings);
initGitAccounts();
gitForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  try {
    const cfg = await api('POST', '/api/git/config', { name: gitForm.name.value, email: gitForm.email.value, autoSync: gitForm.autoSync.checked });
    setAutoSyncDefault(cfg.autoSync);
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
  setPreviewProject(name);
  if (!isNarrow()) document.body.classList.add('sidebar-open');
  showPanel(panel);
  fitViewport();

  if (!(await refreshSessions())) return;
  const names = new Set(sessions.map((s) => s.name));
  // Đọc tab đang làm trước khi mở lại các tab: openTab() gọi activate() nên sẽ ghi đè thành tab cuối.
  const last = store.get(`cpm.active.${name}`, null);
  for (const n of store.get(`cpm.tabs.${name}`, [])) if (names.has(n)) openTab(n);
  if (last && tabs.has(last)) activate(last);
  emptyEl.hidden = tabs.size > 0;
  refreshTimer = setInterval(() => document.visibilityState === 'visible' && refreshSessions(), 3000);
}

function closeProject() {
  clearInterval(refreshTimer);
  setGitProject(null);
  setPreviewProject(null);
  for (const tab of [...tabs.values()]) disposeTab(tab);
  tabs.clear();
  active = null;
  loadDraft(null);
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

// Tên mặc định "Claude 2"/"Terminal 1", hoặc tên anh tự đặt; phiên chạy alias khác claude thì thêm "(alias)".
function sessionLabel(s) {
  const n = s.name.slice(s.name.lastIndexOf('-') + 1);
  const base = s.title || `${s.kind === 'shell' ? 'Terminal' : 'Claude'} ${n}`;
  const warn = s.kind === 'claude-bypass' ? '⚠ ' : '';
  const alias = s.alias && s.alias !== 'claude' ? ` (${s.alias})` : '';
  return `${warn}${base}${alias}`;
}

async function renameSession(s) {
  const n = s.name.slice(s.name.lastIndexOf('-') + 1);
  const title = await inputDialog('Đổi tên phiên (để trống = tên mặc định)', s.title || `${s.kind === 'shell' ? 'Terminal' : 'Claude'} ${n}`, 'Đổi tên');
  if (title === null) return;
  try {
    await api('PATCH', `/api/sessions/${encodeURIComponent(s.name)}`, { title });
  } catch (err) {
    toast(err.message, 'error');
  }
  refreshSessions();
}

const STATE_TITLE = { busy: 'Claude đang chạy', sent: 'Claude đang chạy', idle: 'Claude đã xong', waiting: 'Claude chờ cho phép', ended: 'Claude đã thoát' };

function renderTabLabels() {
  for (const tab of tabs.values()) {
    const s = sessions.find((x) => x.name === tab.name);
    if (!s) continue;
    // replaceChildren không tự bỏ null như el(), nên lọc trước (không thì hiện chữ "null").
    tab.labelEl.replaceChildren(...[
      s.state ? el('span', { class: `tab-dot ${s.state}`, title: STATE_TITLE[s.state] || '' }) : null,
      sessionLabel(s),
      s.queued ? el('span', { class: 'tab-queued', title: `${s.queued} prompt đang chờ`, text: `⏳${s.queued}` }) : null,
    ].filter(Boolean));
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
    const rename = el('button', { class: 'icon-btn small', title: 'Đổi tên', 'aria-label': `Đổi tên ${sessionLabel(s)}`, text: '✎', onclick: () => renameSession(s) });
    const kill = el('button', { class: 'danger-link', text: 'Kết thúc', onclick: () => confirmKill(s) });
    sessionListEl.append(el('li', { class: `session-item${s.name === active ? ' active' : ''}` }, info, rename, kill));
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

// Mở phiên mới: Claude (chọn alias, bypass permissions, tham số thêm) hoặc Terminal (nút nhỏ góc trên).
const dlgNew = $('#dlg-new');
const advancedBox = $('#new-advanced');
const aliasSelect = $('#new-alias');
const bypassInput = $('#new-bypass');
const argsInput = $('#new-args');

async function loadAliases() {
  try {
    const { aliases } = await api('GET', '/api/claude-aliases');
    aliasSelect.replaceChildren(...aliases.map((a) => el('option', { value: a.name, text: a.description ? `${a.name} — ${a.description}` : a.name })));
    aliasSelect.value = aliases.find((a) => a.default)?.name || '';
  } catch (err) {
    toast(err.message, 'error');
  }
}

function syncBypass() {
  $('#new-bypass-warn').hidden = !bypassInput.checked;
  advancedBox.classList.toggle('danger', bypassInput.checked);
  $('#new-custom').className = bypassInput.checked ? 'danger-btn' : 'primary-btn';
  $('#new-custom').textContent = bypassInput.checked ? '⚠ Mở Claude (bypass permissions)' : '✳ Mở Claude';
}
bypassInput.addEventListener('change', syncBypass);
// Enter trong ô tham số: mở Claude (mặc định form sẽ bấm nút đầu tiên là Terminal).
argsInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  dlgNew.close('claude-custom');
});

$('#btn-new').addEventListener('click', () => {
  dlgNew.returnValue = '';
  bypassInput.checked = false;
  argsInput.value = '';
  syncBypass();
  loadAliases();
  dlgNew.showModal();
});
dlgNew.addEventListener('close', async () => {
  const choice = dlgNew.returnValue;
  let body;
  if (choice === 'shell') body = { command: choice };
  else if (choice === 'claude-custom') body = { command: 'claude', alias: aliasSelect.value || undefined, bypass: bypassInput.checked, args: argsInput.value.trim() || undefined };
  else return;
  try {
    const created = await api('POST', projectUrl(project, '/sessions'), body);
    // Tên phiên được dùng lại sau khi phiên cũ kết thúc: phiên mới không mang lịch sử prompt của phiên cũ.
    store.remove(historyKey(created.name));
    removeDraft(created.name);
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
  // Nút "Xuống cuối": hiện khi đã cuộn lên khỏi dòng mới nhất.
  const jump = el('button', { type: 'button', class: 'term-jump', hidden: true, title: 'Xuống cuối', 'aria-label': 'Xuống cuối', text: '↓ Xuống cuối', onclick: () => { term.scrollToBottom(); if (!isTouch) term.focus(); } });
  jump.addEventListener('mousedown', (e) => e.preventDefault());
  elTerm.append(jump);
  const syncJump = () => { const b = term.buffer.active; jump.hidden = b.viewportY >= b.baseY; };
  term.onScroll(syncJump);
  term.onWriteParsed(syncJump);
  // Cmd+C (Mac) / Ctrl+C hoặc Ctrl+Shift+C (máy khác) khi đang bôi đen thì copy luôn, không gửi ^C vào phiên.
  // Không dựa vào sự kiện copy của trình duyệt vì vùng chọn của xterm không phải vùng chọn của trang (WebView hay mất).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || e.code !== 'KeyC' || e.altKey || !term.getSelection()) return true;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return true;
    copyText(term.getSelection()).then((ok) => toast(ok ? 'Đã copy' : 'Trình duyệt chặn copy, mở 📄 để copy', ok ? undefined : 'error'));
    return false;
  });
  if (isTouch || navigator.maxTouchPoints > 0) {
    attachTouch(term, elTerm, {
      onCopy: async (text) => {
        const ok = await copyText(text);
        toast(ok ? 'Đã copy' : 'Trình duyệt chặn copy, mở 📄 để copy', ok ? undefined : 'error');
      },
    });
  }

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
  if (name !== draftOf) loadDraft(name);
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
      loadDraft(null);
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
  enter: keyBtn('⏎', 'Enter', 'enter'),
  ctrl: { label: 'Ctrl', title: 'Giữ Ctrl cho phím gõ tiếp theo', run: () => armCtrl(!ctrlArmed) },
  history: { label: '🕘', title: 'Lịch sử prompt', run: () => showHistory() },
  queue: { label: '📋', title: 'Hàng đợi prompt', run: () => showQueue() },
  text: { label: '📄', title: 'Xem/copy nội dung dạng chữ', run: () => showText() },
  browser: { label: '🌐', title: 'Xem trình duyệt của phiên (Claude test web ở đây)', run: () => showBrowser() },
  preview: { label: '👁', title: 'Khung Preview (design, slide Claude làm)', run: () => togglePreview() },
  'shift-tab': keyBtn('⇧Tab', 'Shift+Tab (đổi chế độ Claude)', 'shift-tab'),
  'font-down': { label: 'A−', title: 'Chữ nhỏ hơn', run: () => setFont(fontSize - 1) },
  'font-up': { label: 'A+', title: 'Chữ to hơn', run: () => setFont(fontSize + 1) },
};
const BAR_DEFAULT = Object.keys(BAR_BUTTONS);
const keybarEl = $('#keybar');

// Cấu hình lưu dạng [{ id, show }]; nút mới thêm sau này chen vào sau nút đứng trước nó trong thứ tự mặc định.
// Đổi thứ tự mặc định thì tăng KEYBAR_KEY để mọi máy dùng lại thứ tự mới.
const KEYBAR_KEY = 'cpm.keybar.v2';
function loadKeybar() {
  const saved = store.get(KEYBAR_KEY, null);
  const list = Array.isArray(saved) ? saved.filter((b) => BAR_BUTTONS[b?.id]) : [];
  BAR_DEFAULT.forEach((id, i) => {
    if (list.some((b) => b.id === id)) return;
    const prev = list.findIndex((b) => b.id === BAR_DEFAULT[i - 1]);
    list.splice(prev + 1, 0, { id, show: true });
  });
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
  store.set(KEYBAR_KEY, keybar);
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

// Lịch sử các prompt đã gửi từ ô prompt, riêng từng phiên (lưu trên trình duyệt này, mới nhất trước).
const HISTORY_MAX = 100;
const historyKey = (name) => `cpm.promptHistory.${name}`;
store.remove('cpm.promptHistory'); // lịch sử chung kiểu cũ, không biết của phiên nào

function rememberPrompt(name, text) {
  const list = store.get(historyKey(name), []).filter((t) => t !== text);
  list.unshift(text);
  store.set(historyKey(name), list.slice(0, HISTORY_MAX));
}

function showHistory() {
  if (!active) return toast('Mở một phiên trước (bấm ＋)', 'error');
  const dlg = $('#dlg-history');
  const s = activeSession();
  $('h2', dlg).textContent = `Lịch sử prompt · ${s ? sessionLabel(s) : active}`;
  const list = store.get(historyKey(active), []);
  const listEl = $('#history-list');
  listEl.replaceChildren(...list.map((text) => el('li', {}, el('button', {
    type: 'button',
    class: 'prompt-text',
    text,
    onclick: () => {
      dlg.close();
      setPrompt(text);
      promptInput.focus();
    },
  }))));
  if (!list.length) listEl.append(el('li', { class: 'muted small', text: 'Phiên này chưa gửi prompt nào.' }));
  dlg.showModal();
}
$('#history-clear').addEventListener('click', async () => {
  $('#dlg-history').close();
  const name = active;
  if (name && (await confirmDialog('Xóa lịch sử prompt của phiên này?', 'Xóa'))) store.remove(historyKey(name));
});

// Xem nội dung phiên dạng chữ thường: chọn/copy bằng thao tác bình thường của trình duyệt,
// vì chọn chữ trong terminal trên điện thoại gần như không dùng được.
const dlgText = $('#dlg-text');
const textBody = $('#text-body');

let plainText = ''; // bản chữ thường đã nối dòng, cho nút Copy hết

// Hiện giống terminal: đúng từng dòng, có màu, cỡ chữ như terminal.
async function showText() {
  if (!active) return toast('Mở một phiên trước (bấm ＋)', 'error');
  const url = `/api/sessions/${encodeURIComponent(active)}/text`;
  textBody.style.fontSize = `${fontSize}px`;
  textBody.textContent = 'Đang tải…';
  plainText = '';
  dlgText.showModal();
  try {
    const [colored, plain] = await Promise.all([api('GET', `${url}?ansi=1`), api('GET', url)]);
    plainText = plain.text.replace(/\s+$/, '');
    renderAnsi(textBody, colored.text.replace(/\s+$/, '') || '(trống)');
    textBody.scrollTop = textBody.scrollHeight;
  } catch (err) {
    textBody.textContent = err.message;
  }
}

$('#text-copy').addEventListener('click', async () => {
  const sel = String(getSelection());
  const ok = await copyText(sel || plainText || textBody.textContent);
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

function showBrowser() {
  const s = activeSession();
  if (!s) return toast('Mở một phiên trước (bấm ＋)', 'error');
  openBrowser(s.name, sessionLabel(s));
}

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
          setPrompt(item.text);
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

// Không đụng vào style.height khi đang gõ IME (Telex/VNI trên macOS): reset height='auto' giữa lúc có chữ gạch chân
// làm WebKit mất vùng soạn thảo và nhảy con trỏ về đầu. Gõ xong (compositionend) mới co giãn.
let composing = false;
function autoGrow() {
  if (composing) return;
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 160)}px`;
}
promptInput.addEventListener('compositionstart', () => { composing = true; });
promptInput.addEventListener('compositionend', () => {
  composing = false;
  autoGrow();
});

// Bản nháp ô prompt riêng từng phiên, giữ trong sessionStorage: đổi tab phiên là đổi luôn nội dung ô prompt.
const draftKey = (name) => `cpm.draft.${name}`;
let draftOf = null; // phiên đang sở hữu nội dung ô prompt

function saveDraft() {
  if (!draftOf) return;
  try {
    if (promptInput.value) sessionStorage.setItem(draftKey(draftOf), promptInput.value);
    else sessionStorage.removeItem(draftKey(draftOf));
  } catch {
    // trình duyệt chặn storage thì bỏ qua
  }
}

function loadDraft(name) {
  saveDraft();
  draftOf = name;
  let text = '';
  try {
    text = (name && sessionStorage.getItem(draftKey(name))) || '';
  } catch {
    // như trên
  }
  promptInput.value = text;
  autoGrow();
}

function removeDraft(name) {
  try {
    sessionStorage.removeItem(draftKey(name));
  } catch {
    // như trên
  }
}

// Gán nội dung ô prompt bằng code (không phát sinh sự kiện input) thì lưu nháp luôn.
function setPrompt(text) {
  promptInput.value = text;
  autoGrow();
  saveDraft();
}

promptInput.addEventListener('input', () => {
  autoGrow();
  saveDraft();
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
  rememberPrompt(tab.name, text);
  // Dán theo kiểu bracketed paste để xuống dòng không bị hiểu là Enter, rồi mới gửi Enter.
  send(tab, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  setTimeout(() => send(tab, '\r'), 80);
  setPrompt('');
});

$('#prompt-queue').addEventListener('click', async () => {
  const s = activeSession();
  const text = promptInput.value;
  if (!s) return toast('Mở một phiên trước (bấm ＋)', 'error');
  if (!text.trim()) return showQueue();
  try {
    const { items } = await api('POST', queueUrl(s.name), { text });
    rememberPrompt(s.name, text);
    // Lúc chờ server có thể đã đổi sang tab khác: chỉ xóa nháp của phiên vừa xếp hàng.
    if (draftOf === s.name) setPrompt('');
    else removeDraft(s.name);
    toast(s.state === 'idle' ? 'Claude đang rảnh, gửi ngay' : `Đã xếp hàng (${items.length} prompt đang chờ)`);
  } catch (err) {
    toast(err.message, 'error');
  }
  refreshSessions();
});

// Chèn đường dẫn file (từ panel File) vào ô prompt, dạng @path mà Claude hiểu.
function insertPath(rel) {
  const v = promptInput.value;
  setPrompt(`${v}${v && !/\s$/.test(v) ? ' ' : ''}@${rel} `);
  if (isNarrow()) toggleSidebar(false);
  promptInput.focus();
}

// Thêm một đoạn chữ vào cuối ô prompt (góp ý từ khung Preview, mô tả hình vẽ).
function appendPrompt(text) {
  const v = promptInput.value.replace(/\s+$/, '');
  setPrompt(`${v}${v ? '\n' : ''}${text}`);
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
$('#prompt-sketch').addEventListener('click', () => openSketch());

// Màn hẹp: 📎 🎨 ⏳ gom vào menu nút ＋ (CSS quyết định), bấm một mục thì đóng menu.
const promptMore = $('#prompt-more');
const promptTools = $('#prompt-tools');
function setToolsOpen(on) {
  promptTools.classList.toggle('open', on);
  promptMore.setAttribute('aria-expanded', String(on));
}
promptMore.addEventListener('pointerdown', (e) => e.preventDefault()); // giữ bàn phím nếu đang gõ
promptMore.addEventListener('click', () => setToolsOpen(!promptTools.classList.contains('open')));
promptTools.addEventListener('pointerdown', (e) => e.preventDefault());
promptTools.addEventListener('click', (e) => e.target.closest('button') && setToolsOpen(false));
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#prompt-tools, #prompt-more')) setToolsOpen(false);
});
if (isTouch) promptInput.placeholder = 'Gõ prompt… (gõ / để chọn lệnh)';

// ---------- Phím tắt (shortcuts.js; phím đổi được ở ⌨ hoặc data/settings.json) ----------

const PANELS = ['sessions', 'files', 'git'];

// Đưa focus vào danh sách của panel đang mở (mục đang chọn nếu có, không thì mục đầu).
function focusPanel(retry = true) {
  if (!document.body.classList.contains('sidebar-open')) toggleSidebar(true);
  const root = $(`#panel-${panel}`);
  const rows = panelRows(root);
  // File/Git tải danh sách bất đồng bộ: chưa có dòng nào thì thử lại một lần sau khi tải xong.
  if (!rows.length && retry) setTimeout(() => { if (!root.contains(document.activeElement)) focusPanel(false); }, 500);
  const target = rows.find((b) => b.closest('li')?.classList.contains('active')) || rows[0]
    || [...root.querySelectorAll('button:not([disabled]), input, textarea, a')].find((n) => n.offsetParent);
  target?.focus();
}

// Mỗi dòng (li) của panel -> nút chính của dòng đó.
function panelRows(root) {
  return [...root.querySelectorAll('li')]
    .map((li) => li.querySelector('button:not([disabled]), a'))
    .filter((b) => b && b.offsetParent);
}

function goPanel(delta, name) {
  const next = name || PANELS[(PANELS.indexOf(panel) + delta + PANELS.length) % PANELS.length];
  showPanel(next);
  focusPanel();
}

// Mũi tên lên/xuống đi qua các dòng trong sidebar (Phiên, File, Git); Enter/Space mở như bấm chuột.
$('#sidebar').addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const li = e.target.closest?.('li');
  if (!li) return;
  const rows = panelRows($(`#panel-${panel}`));
  const i = rows.findIndex((b) => b.closest('li') === li);
  const to = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (i < 0 || !to) return;
  e.preventDefault();
  to.focus();
});

const tabNames = () => [...tabs.keys()];
const goTab = (i) => {
  const name = tabNames()[i];
  if (!name) return false;
  activate(name);
};
const projectCards = () => [...document.querySelectorAll('#project-list .project-card')];
const openCard = (card) => {
  if (!card) return false;
  location.hash = card.getAttribute('href');
};

const shortcutActions = {
  'shortcuts.edit': () => openShortcuts(),

  'tab.next': () => tabNames().length > 1 && goTab((tabNames().indexOf(active) + 1) % tabs.size),
  'tab.prev': () => tabNames().length > 1 && goTab((tabNames().indexOf(active) - 1 + tabs.size) % tabs.size),
  'tab.close': () => (active ? closeTab(active) : false),
  'session.new': () => $('#btn-new').click(),
  'terminal.focus': () => tabs.get(active)?.term.focus(),
  'preview.toggle': () => togglePreview(),
  'project.back': () => { location.hash = '#/'; },

  'sidebar.toggle': () => toggleSidebar(),
  'sidebar.focus': () => focusPanel(),
  'panel.sessions': () => goPanel(0, 'sessions'),
  'panel.files': () => goPanel(0, 'files'),
  'panel.git': () => goPanel(0, 'git'),
  'panel.next': () => goPanel(1),
  'panel.prev': () => goPanel(-1),

  'prompt.focus': () => promptInput.focus(),
  'prompt.send': () => promptForm.requestSubmit(),
  'prompt.queue': () => $('#prompt-queue').click(),
  'queue.show': () => showQueue(),
  'history.show': () => showHistory(),

  'projects.filter': () => {
    const f = $('#project-filter');
    f.focus();
    f.select();
  },
  'projects.next': () => {
    const cards = projectCards();
    if (!cards.length) return false;
    cards[Math.min(cards.indexOf(document.activeElement) + 1, cards.length - 1)].focus();
  },
  'projects.prev': () => {
    const cards = projectCards();
    const i = cards.indexOf(document.activeElement);
    if (i < 0) return false;
    if (i === 0) $('#project-filter').focus();
    else cards[i - 1].focus();
  },
  // Enter ở ô tìm (hoặc chưa focus gì) mở dự án đầu danh sách; đang ở một thẻ thì để Enter mở thẻ đó.
  'projects.open': () => {
    const t = document.activeElement;
    if (t !== $('#project-filter') && t !== document.body) return false;
    return openCard(projectCards()[0]);
  },
  'projects.new': () => $('#btn-new-project').click(),
  'projects.folder': () => $('#btn-open-folder').click(),
};
for (let n = 1; n <= 9; n++) {
  shortcutActions[`tab.${n}`] = () => goTab(n - 1);
  shortcutActions[`projects.open.${n}`] = () => openCard(projectCards()[n - 1]);
}

document.querySelectorAll('.btn-shortcuts').forEach((b) => b.addEventListener('click', openShortcuts));

function applyShortcutHints() {
  const send = shortcutLabel('prompt.send');
  promptInput.placeholder = isTouch
    ? 'Gõ prompt… (gõ / để chọn lệnh)'
    : `Gõ prompt… (dán ảnh được${send ? `, ${send} để gửi` : ''})`;
  $('#prompt-queue').title = `Thêm vào hàng đợi (tự gửi khi Claude xong)${shortcutLabel('prompt.queue') ? ` · ${shortcutLabel('prompt.queue')}` : ''}`;
}


// ---------- Bố cục ----------

function toggleSidebar(force) {
  document.body.classList.toggle('sidebar-open', force ?? !document.body.classList.contains('sidebar-open'));
  requestAnimationFrame(() => tabs.get(active) && safeFit(tabs.get(active)));
}

$('#btn-sidebar').addEventListener('click', () => toggleSidebar());
// Màn hình hẹp: menu đè lên terminal, chạm ra ngoài thì đóng (trừ khi đang ở hộp thoại mở từ menu).
document.addEventListener('pointerdown', (e) => {
  if (!isNarrow() || !document.body.classList.contains('sidebar-open')) return;
  if (e.target.closest('#sidebar, #btn-sidebar, dialog')) return;
  toggleSidebar(false);
});
// Chuyển nhanh giữa các dự án đang có phiên chạy (chấm xanh) ngay trong màn làm việc.
const psBtn = $('#btn-projswitch');
const psMenu = $('#projswitch-menu');
const closeProjSwitch = () => { psMenu.hidden = true; };
psBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!psMenu.hidden) return closeProjSwitch();
  psMenu.replaceChildren(el('li', { class: 'muted pad small', text: 'Đang tải…' }));
  psMenu.hidden = false;
  let list;
  try {
    list = (await api('GET', '/api/projects')).projects;
  } catch (err) {
    closeProjSwitch();
    return toast(err.message, 'error');
  }
  const recent = store.get('cpm.recent', {});
  const live = list.filter((p) => p.sessions).sort((a, b) => (recent[b.name] || 0) - (recent[a.name] || 0));
  psMenu.replaceChildren(...(live.length
    ? live.map((p) => el('li', {}, el('button', {
      type: 'button',
      class: p.name === project ? 'active' : '',
      onclick: () => { closeProjSwitch(); if (p.name !== project) location.hash = `#/p/${encodeURIComponent(p.name)}`; },
    }, el('span', { class: 'dot' }), el('span', { class: 'ellipsis', text: p.name }), el('span', { class: 'muted small', text: `${p.sessions} phiên` }))))
    : [el('li', { class: 'muted pad small', text: 'Chưa có dự án nào đang chạy.' })]));
});
document.addEventListener('click', (e) => { if (!psMenu.contains(e.target)) closeProjSwitch(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProjSwitch(); });
window.addEventListener('hashchange', closeProjSwitch);

$('#btn-back').addEventListener('click', () => { location.hash = '#/'; });
$('#btn-refresh').addEventListener('click', refreshSessions);
document.querySelectorAll('.btn-logout').forEach((btn) => btn.addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  location.href = '/login';
}));

// Trong app mobile: nút quay về màn chọn server.
document.querySelectorAll('.btn-switch-server').forEach((btn) => {
  btn.hidden = !nativeApp;
  btn.addEventListener('click', () => nativeApp?.post({ type: 'switchServer' }));
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
  if (document.visibilityState !== 'visible') return;
  if (project) refreshSessions();
  else if (!viewProjects.hidden) showProjects();
});

// ---------- Khởi động ----------

initFiles({ insertPath, openPreview });
initSketch({
  send: async (file, text) => {
    await attachImages([file]);
    if (text) appendPrompt(text);
    if (!isTouch) promptInput.focus();
  },
});
initPreview({
  insertText: appendPrompt,
  sendText: (text) => {
    appendPrompt(text);
    promptForm.requestSubmit();
  },
  download: (path) => download(path),
  sketch: openSketch,
  onBadge: (on) => {
    if (barEls.preview) barEls.preview.textContent = on ? '👁•' : '👁';
  },
  onLayout: () => requestAnimationFrame(() => tabs.get(active) && safeFit(tabs.get(active))),
});
initSlash({
  context: () => {
    const s = activeSession();
    return project && s && s.kind !== 'shell' ? { project, alias: s.alias } : null;
  },
});
// Pull bị xung đột: thanh khóa dự án có nút mở phiên Claude đang xử lý.
initGit({
  openSession: async (name) => {
    await refreshSessions();
    if (!sessions.some((s) => s.name === name)) return toast('Phiên xử lý xung đột đã tắt', 'error');
    if (isNarrow()) toggleSidebar(false);
    openTab(name);
  },
});
fitViewport();
initShortcuts({
  actions: shortcutActions,
  view: () => (viewWorkspace.hidden ? 'projects' : 'workspace'),
  onChange: applyShortcutHints,
});
route();
