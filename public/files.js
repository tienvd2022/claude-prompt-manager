// Panel quản lý file của dự án: duyệt thư mục, xem/sửa file, upload, tải về, đổi tên, xóa.

import { $, el, api, projectUrl, formatSize, timeAgo, toast, confirmDialog, inputDialog, nativeApp } from './common.js';
import { openViewer } from './viewer.js';

const LONG_PRESS_MS = 500;

const panel = $('#panel-files');
const listEl = $('#files-list');
const crumbsEl = $('#files-crumbs');
const progressEl = $('#files-progress');
const fileInput = $('#files-input');

let project = null;
let cwd = '';
let onInsert = () => {};

export function initFiles({ insertPath }) {
  onInsert = insertPath;
  $('#files-up').addEventListener('click', () => {
    if (cwd) load(cwd.split('/').slice(0, -1).join('/'));
  });
  $('#files-refresh').addEventListener('click', () => load(cwd));
  $('#files-mkdir').addEventListener('click', makeDir);
  $('#files-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    uploadAll([...fileInput.files]);
    fileInput.value = '';
  });
  // Kéo thả file từ máy vào panel để upload.
  panel.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    panel.classList.add('dropping');
  });
  panel.addEventListener('dragleave', (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove('dropping');
  });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.classList.remove('dropping');
    uploadAll([...(e.dataTransfer?.files || [])]);
  });
}

export function setFilesProject(name) {
  if (project === name) return;
  project = name;
  cwd = '';
  listEl.replaceChildren();
  crumbsEl.replaceChildren();
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

export async function load(dir = cwd) {
  if (!project) return;
  let data;
  try {
    data = await api('GET', projectUrl(project, `/files?path=${encodeURIComponent(dir)}`));
  } catch (err) {
    toast(err.message, 'error');
    if (dir) return load(''); // thư mục đã bị xóa thì về gốc
    return;
  }
  cwd = data.path;
  renderCrumbs();
  listEl.replaceChildren();
  if (!data.entries.length) listEl.append(el('li', { class: 'muted pad', text: 'Thư mục trống. Kéo thả file vào đây để upload.' }));
  for (const entry of data.entries) listEl.append(renderEntry(entry));
  if (data.truncated) listEl.append(el('li', { class: 'muted pad', text: 'Quá nhiều file, chỉ hiện một phần.' }));
}

function renderCrumbs() {
  crumbsEl.replaceChildren(el('button', { class: 'crumb', text: project, onclick: () => load('') }));
  let acc = '';
  for (const part of cwd ? cwd.split('/') : []) {
    acc = join(acc, part);
    const target = acc;
    crumbsEl.append(el('span', { class: 'sep', text: '/' }), el('button', { class: 'crumb', text: part, onclick: () => load(target) }));
  }
  $('#files-up').disabled = !cwd;
}

function renderEntry(entry) {
  const rel = join(cwd, entry.name);
  const isDir = entry.type === 'dir';
  const meta = isDir ? (entry.link ? 'liên kết' : '') : `${formatSize(entry.size)} · ${timeAgo(entry.mtime)}`;
  const open = el('button', {
    class: 'entry-open',
    title: isDir ? 'Mở thư mục (ấn giữ để xem tác vụ)' : 'Xem file (ấn giữ để xem tác vụ)',
  },
  el('span', { class: 'entry-icon', text: isDir ? '📁' : '📄' }),
  el('span', { class: 'entry-name', text: entry.name }),
  meta ? el('span', { class: 'entry-meta', text: meta }) : null);
  onTapOrHold(open, () => (isDir ? load(rel) : openViewer({ project, path: rel, onSaved: () => load(cwd) })), () => entryActions(entry, rel));
  const more = el('button', { class: 'icon-btn small', title: 'Tác vụ', 'aria-label': `Tác vụ với ${entry.name}`, text: '⋯', onclick: () => entryActions(entry, rel) });
  return el('li', { class: 'entry' }, open, more);
}

// Bấm thì onTap, ấn giữ (hoặc chuột phải) thì onHold; ấn giữ xong không tính thêm lần bấm.
function onTapOrHold(node, onTap, onHold) {
  let timer = null;
  let held = false;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    held = false;
    start = [e.clientX, e.clientY];
    cancel();
    timer = setTimeout(() => {
      timer = null;
      held = true;
      onHold();
    }, LONG_PRESS_MS);
  });
  node.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) cancel();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) node.addEventListener(ev, cancel);
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
    if (!held) {
      held = true;
      onHold();
    }
  });
  node.addEventListener('click', () => {
    if (held) {
      held = false;
      return;
    }
    onTap();
  });
}

function entryActions(entry, rel) {
  const dlg = $('#dlg-entry');
  const isDir = entry.type === 'dir';
  $('h2', dlg).textContent = entry.name;
  $('#entry-meta', dlg).textContent = isDir ? `Thư mục · ${rel}` : `${formatSize(entry.size)} · sửa ${timeAgo(entry.mtime)} · ${rel}`;
  $('#entry-download', dlg).textContent = isDir ? 'Tải về (.tar.gz)' : 'Tải về';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    const action = dlg.returnValue;
    if (action === 'download') download(rel, isDir);
    else if (action === 'insert') onInsert(isDir ? `${rel}/` : rel);
    else if (action === 'rename') renameEntry(entry, rel);
    else if (action === 'delete') deleteEntry(entry, rel);
  }, { once: true });
}

async function download(rel, isDir) {
  if (nativeApp) {
    // WebView không tự tải file: xin link tải dùng một lần rồi để app native tải, lưu/chia sẻ.
    try {
      const { url } = await api('POST', projectUrl(project, '/download-ticket'), { path: rel });
      const name = rel.split('/').pop() || project;
      nativeApp.post({ type: 'download', url: new URL(url, location.href).href, name: isDir ? `${name}.tar.gz` : name });
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }
  // Trình duyệt tự gửi cookie đăng nhập; link tạm để tải không làm mất trang.
  const a = el('a', { href: projectUrl(project, `/download?path=${encodeURIComponent(rel)}`), download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function renameEntry(entry, rel) {
  const name = await inputDialog('Đổi tên', entry.name, 'Đổi tên');
  if (!name || name === entry.name) return;
  try {
    await api('POST', projectUrl(project, '/rename'), { path: rel, name });
    toast('Đã đổi tên');
  } catch (err) {
    toast(err.message, 'error');
  }
  load();
}

async function deleteEntry(entry, rel) {
  const what = entry.type === 'dir' ? `thư mục "${entry.name}" và mọi thứ bên trong` : `file "${entry.name}"`;
  if (!(await confirmDialog(`Xóa vĩnh viễn ${what}? Không khôi phục được.`, 'Xóa'))) return;
  try {
    await api('DELETE', projectUrl(project, `/files?path=${encodeURIComponent(rel)}`));
    toast('Đã xóa');
  } catch (err) {
    toast(err.message, 'error');
  }
  load();
}

async function makeDir() {
  const name = await inputDialog('Thư mục mới', '', 'Tạo');
  if (!name) return;
  try {
    await api('POST', projectUrl(project, '/mkdir'), { path: cwd, name });
    await load(join(cwd, name));
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Upload ----------

function sendFile(file, dir, overwrite) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams({ path: dir, name: file.name });
    if (overwrite) qs.set('overwrite', '1');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', projectUrl(project, `/upload?${qs}`));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) showProgress(`${file.name}: ${Math.round((e.loaded / e.total) * 100)}%`);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // nginx trả HTML khi file vượt giới hạn
      }
      if (xhr.status === 401) location.href = '/login';
      resolve({ status: xhr.status, error: data.error || (xhr.status === 413 ? 'File quá lớn' : `Lỗi ${xhr.status}`) });
    };
    xhr.onerror = () => resolve({ status: 0, error: 'Mất kết nối' });
    xhr.send(file);
  });
}

function showProgress(text) {
  progressEl.textContent = text;
  progressEl.hidden = false;
}

async function uploadAll(fileList) {
  if (!fileList.length || !project) return;
  const dir = cwd;
  let done = 0;
  for (const file of fileList) {
    showProgress(`${file.name}: 0%`);
    let r = await sendFile(file, dir, false);
    if (r.status === 409) {
      if (!(await confirmDialog(`"${file.name}" đã có trong thư mục này. Ghi đè?`, 'Ghi đè'))) continue;
      r = await sendFile(file, dir, true);
    }
    if (r.status === 201) done++;
    else toast(`${file.name}: ${r.error}`, 'error');
  }
  progressEl.hidden = true;
  if (done) toast(`Đã upload ${done} file`);
  if (dir === cwd) load(dir);
}
