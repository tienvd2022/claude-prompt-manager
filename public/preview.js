// Khung Preview cạnh terminal: hiện file HTML/SVG Claude viết (design, slide, mockup), tự tải lại khi file đổi.
// Trang chạy trong iframe sandbox (origin riêng, xem src/preview.js), chỉ nói chuyện với app qua postMessage:
// báo slide đang xem, gửi phần tử anh chọn để góp ý.

import { $, api, projectUrl, store, toast, isNarrow } from './common.js';

const DIR = '.cpm/preview';
const LIST_MS = 3000;
const STAT_MS = 1500;
const PAGE_RE = /\.(html?|svg)$/i;

const pane = $('#preview');
const frame = $('#pv-frame');
const msgEl = $('#pv-msg');
const select = $('#pv-file');
const inspectBtn = $('#pv-inspect');
const pdfBtn = $('#pv-pdf');
const dlgFb = $('#dlg-feedback');
const fbForm = $('#feedback-form');

let project = null;
let files = []; // [{ path, mtime }] trong .cpm/preview
let known = null; // path -> mtime ở lần hỏi trước (null = chưa có mốc, lần đầu không tự mở)
let cur = null; // file đang xem
let curMtime = 0;
let slide = 0; // slide đang xem (slides.js báo về), giữ lại khi tải lại
let inspecting = false;
let listTimer = 0;
let statTimer = 0;
let cb = {};

const lastKey = (p) => `cpm.preview.last.${p}`;
const pinnedKey = (p) => `cpm.preview.pinned.${p}`; // file mở tay ngoài .cpm/preview
const baseName = (p) => p.split('/').pop();
const isOpen = () => !pane.hidden;

export const canPreview = (path) => PAGE_RE.test(path);

// cb: { insertText(text), sendText(text), download(path), sketch(opts), onBadge(on), onLayout() }
export function initPreview(callbacks) {
  cb = callbacks;
  select.addEventListener('change', () => openPreview(select.value));
  $('#pv-reload').addEventListener('click', () => load());
  $('#pv-device').addEventListener('click', () => setDevice(store.get('cpm.preview.device', 'full') === 'phone' ? 'full' : 'phone'));
  inspectBtn.addEventListener('click', () => setInspect(!inspecting));
  $('#pv-draw').addEventListener('click', drawOnPage);
  pdfBtn.addEventListener('click', exportPdf);
  $('#pv-open').addEventListener('click', async () => {
    if (cur) window.open(await pageUrl(), '_blank', 'noopener');
  });
  $('#pv-max').addEventListener('click', () => {
    pane.classList.toggle('pv-max');
    cb.onLayout?.();
  });
  $('#pv-close').addEventListener('click', closePreview);
  setDevice(store.get('cpm.preview.device', 'full'));
  initResize();

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || !e.data?.cpm) return;
    const d = e.data;
    if (d.type === 'ready') sendInspect();
    else if (d.type === 'slide') slide = Number(d.index) || 0;
    else if (d.type === 'picked') feedback(d);
    else if (d.type === 'inspect-cancel') setInspect(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isOpen()) checkStat();
  });
}

export function setPreviewProject(name) {
  if (project === name) return;
  closePreview();
  clearInterval(listTimer);
  project = name;
  files = [];
  known = null;
  cur = name ? store.get(lastKey(name), null) : null;
  setBadge(false);
  if (!name) return;
  pollList();
  listTimer = setInterval(() => document.visibilityState === 'visible' && pollList(), LIST_MS);
}

export function togglePreview() {
  if (isOpen()) closePreview();
  else openPreview();
}

export async function openPreview(path) {
  if (!project) return toast('Mở một dự án trước', 'error');
  if (path && path !== cur) {
    slide = 0;
    cur = path;
  }
  if (!cur && files.length) cur = files[0].path;
  if (cur) store.set(lastKey(project), cur);
  if (cur && !cur.startsWith(`${DIR}/`)) pin(cur);
  pane.hidden = false;
  document.body.classList.add('preview-open');
  setBadge(false);
  renderSelect();
  cb.onLayout?.();
  clearInterval(statTimer);
  if (!cur) return showMessage(`Chưa có file preview. Nhờ Claude làm design/slide (Claude sẽ ghi vào ${DIR}/), hoặc mở file .html từ panel File.`);
  curMtime = 0;
  await checkStat(true);
  statTimer = setInterval(() => document.visibilityState === 'visible' && checkStat(), STAT_MS);
}

export function closePreview() {
  clearInterval(statTimer);
  setInspect(false);
  pane.hidden = true;
  pane.classList.remove('pv-max');
  document.body.classList.remove('preview-open');
  frame.removeAttribute('src');
  cb.onLayout?.();
}

function setBadge(on) {
  cb.onBadge?.(on);
}

function pin(path) {
  const list = store.get(pinnedKey(project), []).filter((p) => p !== path);
  list.unshift(path);
  store.set(pinnedKey(project), list.slice(0, 10));
}

function renderSelect() {
  const paths = [...new Set([...(cur ? [cur] : []), ...files.map((f) => f.path), ...store.get(pinnedKey(project), [])])];
  select.replaceChildren(...paths.map((p) => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p.startsWith(`${DIR}/`) ? baseName(p) : p;
    return o;
  }));
  select.hidden = !paths.length;
  if (cur) select.value = cur;
  pdfBtn.disabled = !cur || !/\.html?$/i.test(cur);
}

// Claude tạo file mới trong .cpm/preview: máy tính thì mở luôn, điện thoại thì báo (không che terminal).
async function pollList() {
  const my = project;
  let res;
  try {
    res = await api('GET', projectUrl(my, '/preview/list'));
  } catch {
    return;
  }
  if (my !== project) return;
  files = res.files;
  const fresh = known ? files.filter((f) => !known.has(f.path)) : [];
  const changed = known ? files.filter((f) => known.get(f.path) < f.mtime && f.path !== cur) : [];
  known = new Map(files.map((f) => [f.path, f.mtime]));
  if (isOpen()) renderSelect();
  if (fresh.length) {
    if (isOpen() || !isNarrow()) openPreview(fresh[0].path);
    else {
      cur = fresh[0].path;
      slide = 0;
      setBadge(true);
      toast(`Claude vừa tạo ${baseName(fresh[0].path)}, bấm 👁 để xem`);
    }
  } else if (changed.length && !isOpen()) setBadge(true);
}

async function checkStat(force = false) {
  if (!cur || !project) return;
  const my = cur;
  let st;
  try {
    st = await api('GET', projectUrl(project, `/preview/stat?path=${encodeURIComponent(cur)}`));
  } catch (err) {
    if (my === cur) showMessage(`${cur}: ${err.message}`);
    curMtime = 0;
    return;
  }
  if (my !== cur) return;
  if (force || st.mtime !== curMtime) {
    curMtime = st.mtime;
    load();
  }
}

// Link tới trang (xin lại token mỗi lần: server restart thì token cũ mất).
async function pageUrl() {
  const { base } = await api('POST', projectUrl(project, '/preview/ticket'));
  return `${base}${cur.split('/').map(encodeURIComponent).join('/')}`;
}

async function load() {
  if (!cur) return;
  try {
    const url = `${await pageUrl()}?v=${Math.round(curMtime)}${slide ? `#${slide}` : ''}`;
    msgEl.hidden = true;
    frame.hidden = false;
    frame.src = url;
  } catch (err) {
    showMessage(err.message);
  }
}

function showMessage(text) {
  frame.hidden = true;
  frame.removeAttribute('src');
  msgEl.textContent = text;
  msgEl.hidden = false;
}

function setDevice(mode) {
  store.set('cpm.preview.device', mode);
  pane.classList.toggle('pv-phone', mode === 'phone');
  $('#pv-device').classList.toggle('active', mode === 'phone');
}

// Kéo mép trái của khung để đổi độ rộng (chỉ khi chia đôi màn hình).
function initResize() {
  const handle = $('#pv-resize');
  const saved = store.get('cpm.preview.width', 0);
  if (saved) pane.style.setProperty('--pv-width', `${saved}px`);
  handle.addEventListener('pointerdown', (e) => {
    if (isNarrow()) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    pane.classList.add('pv-dragging');
    const stage = pane.parentElement.getBoundingClientRect();
    const move = (ev) => {
      const w = Math.max(280, Math.min(stage.width - 240, stage.right - ev.clientX));
      pane.style.setProperty('--pv-width', `${w}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      pane.classList.remove('pv-dragging');
      store.set('cpm.preview.width', parseInt(pane.style.getPropertyValue('--pv-width'), 10) || 0);
      cb.onLayout?.();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
}

// ---------- Góp ý: bấm vào phần tử trên trang ----------

function sendInspect() {
  frame.contentWindow?.postMessage({ cpm: 1, type: 'inspect', on: inspecting }, '*');
}

function setInspect(on) {
  if (on && !cur) return;
  inspecting = on;
  inspectBtn.classList.toggle('active', on);
  pane.classList.toggle('pv-inspecting', on);
  sendInspect();
  if (on) toast('Bấm vào phần tử trên trang muốn góp ý (Esc hoặc bấm 🎯 lần nữa để thôi)');
}

function feedback(d) {
  const where = `${cur}${d.slide ? ` (slide ${d.slide})` : ''}`;
  $('#fb-where').textContent = where;
  $('#fb-selector').textContent = d.selector;
  $('#fb-text').textContent = d.text ? `“${d.text}”` : d.tag;
  fbForm.note.value = '';
  dlgFb.returnValue = '';
  dlgFb.showModal();
  dlgFb.addEventListener('close', () => {
    const action = dlgFb.returnValue;
    const note = fbForm.note.value.trim();
    if (!note || (action !== 'add' && action !== 'send')) return;
    const text = `Góp ý trên preview ${where}, phần tử \`${d.selector}\`${d.text ? ` (chữ: "${d.text}")` : ''}: ${note}`;
    if (action === 'send') {
      setInspect(false);
      cb.sendText(text);
    } else {
      cb.insertText(text);
      toast('Đã thêm vào ô prompt. Chọn tiếp phần tử khác, hoặc bấm Gửi.');
    }
  }, { once: true });
}

// ---------- Xuất PDF, vẽ lên trang ----------

async function exportPdf() {
  if (!cur) return;
  pdfBtn.disabled = true;
  toast('Đang xuất PDF…');
  try {
    const { path } = await api('POST', projectUrl(project, '/preview/pdf'), { path: cur });
    toast(`Đã lưu ${path}`);
    cb.download(path);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    pdfBtn.disabled = false;
  }
}

// Server chụp trang ở đúng khổ đang xem, mở canvas để vẽ/khoanh lên rồi gửi kèm prompt.
async function drawOnPage() {
  if (!cur) return cb.sketch({});
  setInspect(false);
  const r = frame.getBoundingClientRect();
  toast('Đang chụp trang…');
  try {
    const res = await fetch(projectUrl(project, '/preview/shot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: cur, width: r.width, height: r.height, hash: slide || '' }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Lỗi ${res.status}`);
    const background = await createImageBitmap(await res.blob());
    const where = `${cur}${slide ? ` (slide ${slide})` : ''}`;
    cb.sketch({ background, title: `Vẽ lên ${baseName(cur)}`, context: `Ảnh chụp preview ${where}, chỗ vẽ/khoanh là chỗ cần sửa` });
  } catch (err) {
    toast(`Không chụp được trang: ${err.message}`, 'error');
  }
}
