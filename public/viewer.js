// Xem file (chữ, ảnh, SVG) và diff, sửa được file chữ trong thư mục làm việc.
// Dùng chung cho panel File và panel Git.

import { $, api, projectUrl, toast, confirmDialog, renderDiff, formatSize } from './common.js';

const dlg = $('#dlg-file');
const titleEl = $('h2', dlg);
const metaEl = $('#fv-meta');
const modesEl = $('#fv-modes');
const textEl = $('#fv-text');
const imageBox = $('#fv-image');
const imageEl = $('img', imageBox);
const editor = $('#fv-editor');
const editBtn = $('#fv-edit');
const saveBtn = $('#fv-save');
const cancelBtn = $('#fv-cancel');

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

let cur = null; // { project, path, rev, diff, onSaved, mode, mtime, editing }
let token = 0; // bỏ kết quả tải cũ khi đã chuyển file/chế độ

const isDirty = () => cur?.editing && editor.value !== cur.original;

modesEl.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', () => showMode(btn.dataset.mode)));
editBtn.addEventListener('click', startEdit);
saveBtn.addEventListener('click', save);
cancelBtn.addEventListener('click', async () => {
  if (isDirty() && !(await confirmDialog('Bỏ các thay đổi chưa lưu?', 'Bỏ'))) return;
  showMode('file');
});
$('#fv-close').addEventListener('click', () => tryClose());
dlg.addEventListener('cancel', (e) => {
  e.preventDefault();
  tryClose();
});
editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

async function tryClose() {
  if (isDirty() && !(await confirmDialog('Đóng mà không lưu thay đổi?', 'Đóng'))) return;
  cur = null;
  dlg.close();
}

// opts: { project, path, rev (null = thư mục làm việc), diff (hàm trả về chữ diff, có thì có tab Diff), mode, onSaved }
export function openViewer(opts) {
  cur = { ...opts, rev: opts.rev || null, editing: false };
  titleEl.textContent = opts.path;
  titleEl.title = opts.path;
  modesEl.hidden = !opts.diff;
  if (!dlg.open) dlg.showModal();
  showMode(opts.diff && opts.mode !== 'file' ? 'diff' : 'file');
}

function setBody(kind) {
  textEl.hidden = kind !== 'text';
  imageBox.hidden = kind !== 'image';
  editor.hidden = kind !== 'edit';
}

function setButtons() {
  const editable = !cur.rev && cur.mode === 'file' && (!IMAGE_RE.test(cur.path) || /\.svg$/i.test(cur.path));
  editBtn.hidden = cur.editing || !editable;
  saveBtn.hidden = cancelBtn.hidden = !cur.editing;
  modesEl.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === cur.mode);
    b.disabled = cur.editing;
  });
}

async function showMode(mode) {
  const my = ++token;
  cur.mode = mode;
  cur.editing = false;
  setButtons();
  metaEl.textContent = cur.rev ? `tại commit ${cur.rev.slice(0, 7)}` : '';
  textEl.className = mode === 'diff' ? 'diff' : 'diff plain';
  textEl.textContent = 'Đang tải…';
  setBody('text');
  try {
    if (mode === 'diff') {
      const text = await cur.diff();
      if (my === token) renderDiff(textEl, text || '(không có khác biệt nội dung)');
      return;
    }
    if (IMAGE_RE.test(cur.path)) {
      const qs = new URLSearchParams({ path: cur.path, t: Date.now() });
      if (cur.rev) qs.set('rev', cur.rev);
      imageEl.onerror = () => {
        if (my !== token) return;
        textEl.textContent = 'Không mở được ảnh (file không còn hoặc lỗi).';
        setBody('text');
      };
      imageEl.onload = () => {
        if (my === token) metaEl.textContent = [metaEl.textContent, `${imageEl.naturalWidth}×${imageEl.naturalHeight}`].filter(Boolean).join(' · ');
      };
      imageEl.src = projectUrl(cur.project, `${cur.rev ? '/git/image' : '/image'}?${qs}`);
      setBody('image');
      return;
    }
    const text = await loadText();
    if (my === token) textEl.textContent = text;
  } catch (err) {
    if (my === token) textEl.textContent = err.message;
  }
}

async function loadText() {
  if (cur.rev) {
    const qs = new URLSearchParams({ rev: cur.rev, path: cur.path });
    return (await api('GET', projectUrl(cur.project, `/git/file?${qs}`))).text;
  }
  const data = await api('GET', projectUrl(cur.project, `/text?path=${encodeURIComponent(cur.path)}`));
  cur.mtime = data.mtime;
  metaEl.textContent = formatSize(data.size);
  if (data.tooLarge) throw new Error(`File quá lớn để xem (${formatSize(data.size)}), hãy tải về.`);
  if (data.binary) throw new Error('File nhị phân, không xem được dạng chữ. Hãy tải về.');
  return data.text;
}

async function startEdit() {
  const my = ++token;
  try {
    // Luôn đọc bản mới nhất trước khi sửa (Claude có thể vừa sửa file).
    const text = await loadText();
    if (my !== token) return;
    cur.editing = true;
    cur.original = text;
    editor.value = text;
    setButtons();
    setBody('edit');
    editor.focus();
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function save() {
  if (!cur?.editing) return;
  saveBtn.disabled = true;
  try {
    const res = await api('PUT', projectUrl(cur.project, '/text'), { path: cur.path, text: editor.value, mtime: cur.mtime });
    cur.mtime = res.mtime;
    cur.original = editor.value;
    toast('Đã lưu');
    cur.onSaved?.();
    showMode('file');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    saveBtn.disabled = false;
  }
}
