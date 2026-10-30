// Xem trực tiếp trình duyệt riêng của một phiên Claude: server gửi ảnh chụp liên tục, chuột/phím/chữ gửi ngược lại.

import { $, el, api, toast, confirmDialog, isTouch } from './common.js';

const dlg = $('#dlg-browser');
const titleEl = $('h2', dlg);
const screen = $('#bv-screen');
const img = $('#bv-img');
const msgEl = $('#bv-msg');
const urlInput = $('#bv-url');
const pagesSelect = $('#bv-pages');
const textInput = $('#bv-text');

let session = null;
let ws = null;
let meta = null; // kích thước trang (px CSS) của khung hình gần nhất, để đổi tọa độ chuột
let retry = null;

const MOD = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setMessage(text) {
  msgEl.textContent = text || '';
  img.hidden = !!text || !img.src;
}

export function openBrowser(name, label) {
  if (session !== name) close();
  session = name;
  titleEl.textContent = `Trình duyệt · ${label}`;
  if (!dlg.open) dlg.showModal();
  if (!ws) connect();
  if (!isTouch) screen.focus();
}

function close() {
  clearTimeout(retry);
  ws?.close();
  ws = null;
  meta = null;
  img.removeAttribute('src');
  setMessage('');
}

function connect() {
  clearTimeout(retry);
  setMessage('Đang mở trình duyệt…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws/browser?session=${encodeURIComponent(session)}`);
  ws = sock;
  sock.onopen = sendSize;
  sock.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'frame') {
      if (!msg.data) {
        meta = null;
        img.removeAttribute('src');
        return setMessage('Chưa có tab nào. Bấm ＋ để mở tab mới, hoặc nhờ Claude mở trang cần test.');
      }
      meta = msg.meta;
      img.src = `data:image/jpeg;base64,${msg.data}`;
      setMessage('');
    } else if (msg.type === 'pages') renderPages(msg);
    else if (msg.type === 'error') setMessage(msg.message);
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    if (e.code === 4004) return setMessage('Phiên này không có trình duyệt riêng (phiên Terminal, hoặc phiên Claude mở trước khi có tính năng này). Mở phiên Claude mới để dùng.');
    if (e.code === 4001) return setMessage('Đã tắt trình duyệt. Mở lại cửa sổ này hoặc để Claude dùng là nó tự bật lại.');
    setMessage('Mất kết nối, đang nối lại…');
    if (dlg.open) retry = setTimeout(connect, 2000);
  };
}

function renderPages({ list, current, follow }) {
  const options = [el('option', { value: '', text: 'Tự theo tab mới nhất' })];
  for (const p of list) options.push(el('option', { value: p.id, text: p.title || p.url || 'Tab trống' }));
  // Chỉ vẽ lại khi danh sách đổi, để không đóng menu chọn đang mở.
  const sig = JSON.stringify([list, current, follow]);
  if (pagesSelect.dataset.sig !== sig) {
    pagesSelect.dataset.sig = sig;
    pagesSelect.replaceChildren(...options);
    pagesSelect.value = follow ? '' : current || '';
  }
  const page = list.find((p) => p.id === current);
  if (document.activeElement !== urlInput) urlInput.value = page?.url && page.url !== 'about:blank' ? page.url : '';
}

function sendSize() {
  const dpr = window.devicePixelRatio || 1;
  send({ type: 'size', w: Math.round(screen.clientWidth * dpr), h: Math.round(screen.clientHeight * dpr) });
}

// Tọa độ trên ảnh -> tọa độ trên trang.
function point(e) {
  const r = img.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * meta.deviceWidth, y: ((e.clientY - r.top) / r.height) * meta.deviceHeight };
}

const BUTTON = ['left', 'middle', 'right'];
let touch = null; // ngón tay đang chạm: chạm nhẹ là bấm, kéo là cuộn trang
let moveQueued = null;

img.addEventListener('pointerdown', (e) => {
  if (!meta) return;
  e.preventDefault();
  try {
    img.setPointerCapture(e.pointerId);
  } catch {
    // con trỏ đã nhả trước khi kịp giữ
  }
  if (!isTouch) screen.focus();
  if (e.pointerType === 'touch') {
    touch = { x: e.clientX, y: e.clientY, moved: false };
    return;
  }
  send({ type: 'mouse', event: 'mousePressed', ...point(e), button: BUTTON[e.button] || 'left', buttons: e.buttons, clickCount: e.detail || 1, modifiers: MOD(e) });
});

img.addEventListener('pointermove', (e) => {
  if (!meta) return;
  if (e.pointerType === 'touch') {
    if (!touch) return;
    const dx = touch.x - e.clientX;
    const dy = touch.y - e.clientY;
    if (!touch.moved && Math.hypot(dx, dy) < 8) return;
    touch.moved = true;
    const r = img.getBoundingClientRect();
    const scale = meta.deviceWidth / r.width;
    send({ type: 'wheel', ...point(e), dx: dx * scale, dy: dy * scale });
    touch.x = e.clientX;
    touch.y = e.clientY;
    return;
  }
  // Gộp các lần rê chuột trong một khung hình.
  const first = !moveQueued;
  moveQueued = { ...point(e), buttons: e.buttons, modifiers: MOD(e) };
  if (first) {
    requestAnimationFrame(() => {
      const m = moveQueued;
      moveQueued = null;
      const button = m.buttons & 1 ? 'left' : m.buttons & 4 ? 'middle' : m.buttons & 2 ? 'right' : 'none';
      send({ type: 'mouse', event: 'mouseMoved', x: m.x, y: m.y, buttons: m.buttons, button, modifiers: m.modifiers });
    });
  }
});

img.addEventListener('pointerup', (e) => {
  if (!meta) return;
  if (e.pointerType === 'touch') {
    if (touch && !touch.moved) {
      const p = point(e);
      send({ type: 'mouse', event: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
      send({ type: 'mouse', event: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
    }
    touch = null;
    return;
  }
  send({ type: 'mouse', event: 'mouseReleased', ...point(e), button: BUTTON[e.button] || 'left', buttons: e.buttons, clickCount: e.detail || 1, modifiers: MOD(e) });
});
img.addEventListener('pointercancel', () => {
  touch = null;
});
img.addEventListener('contextmenu', (e) => e.preventDefault());

screen.addEventListener('wheel', (e) => {
  if (!meta || e.target !== img) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  send({ type: 'wheel', ...point(e), dx: e.deltaX * k, dy: e.deltaY * k, modifiers: MOD(e) });
}, { passive: false });

// Phím gõ khi khung trình duyệt đang được chọn (máy tính). Điện thoại dùng ô "Gõ chữ" bên dưới.
function keyMessage(e, event) {
  const text = event === 'keyDown' && !e.ctrlKey && !e.metaKey ? (e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : undefined) : undefined;
  return { type: 'key', event: event === 'keyDown' && !text ? 'rawKeyDown' : event, key: e.key, code: e.code, keyCode: e.keyCode, text, modifiers: MOD(e) };
}
screen.addEventListener('keydown', (e) => {
  // ⌘/Ctrl+V để dán chữ vào trang (sự kiện paste bên dưới), Esc vẫn đóng cửa sổ như bình thường.
  if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v')) return;
  e.preventDefault();
  send(keyMessage(e, 'keyDown'));
});
screen.addEventListener('keyup', (e) => {
  if (e.key === 'Escape') return;
  e.preventDefault();
  send(keyMessage(e, 'keyUp'));
});
screen.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  send({ type: 'text', text });
});

$('#bv-type').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!textInput.value) return;
  send({ type: 'text', text: textInput.value });
  textInput.value = '';
});
const ENTER = { type: 'key', key: 'Enter', code: 'Enter', keyCode: 13 };
$('#bv-enter').addEventListener('click', () => {
  send({ ...ENTER, event: 'keyDown', text: '\r' });
  send({ ...ENTER, event: 'keyUp' });
});

$('#bv-url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'navigate', url: urlInput.value });
  urlInput.blur();
});
$('#bv-back').addEventListener('click', () => send({ type: 'history', delta: -1 }));
$('#bv-fwd').addEventListener('click', () => send({ type: 'history', delta: 1 }));
$('#bv-reload').addEventListener('click', () => send({ type: 'reload' }));
$('#bv-new').addEventListener('click', () => send({ type: 'newpage' }));
pagesSelect.addEventListener('change', () => send({ type: 'page', id: pagesSelect.value || null }));

$('#bv-stop').addEventListener('click', async () => {
  if (!(await confirmDialog('Tắt trình duyệt của phiên này? Các tab đang mở sẽ đóng hết; Claude hoặc anh dùng lại thì nó tự bật.', 'Tắt'))) return;
  try {
    await api('DELETE', `/api/sessions/${encodeURIComponent(session)}/browser`);
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#bv-close').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => {
  close();
  session = null;
});
new ResizeObserver(() => dlg.open && sendSize()).observe(screen);
