// Vẽ phác: canvas trống hoặc vẽ lên ảnh chụp trang preview, xong thì gửi ảnh kèm prompt cho Claude.

import { $, confirmDialog } from './common.js';

const dlg = $('#dlg-sketch');
const titleEl = $('h2', dlg);
const wrap = $('#sk-wrap');
const canvas = $('#sk-canvas');
const ctx = canvas.getContext('2d');
const noteInput = $('#sk-note');
const ink = document.createElement('canvas'); // nét vẽ riêng một lớp, để tẩy không xóa mất ảnh nền
const inkCtx = ink.getContext('2d');

let background = null;
let context = '';
let strokes = [];
let drawing = null;
let tool = 'pen';
let color = '#e5484d';
let size = 4;
let onSend = async () => {};

// send(file, text): đính kèm ảnh vào ô prompt, kèm dòng chữ mô tả.
export function initSketch({ send }) {
  onSend = send;
  pick('#sk-tools [data-tool]', (b) => { tool = b.dataset.tool; });
  pick('#sk-tools [data-color]', (b) => { color = b.dataset.color; });
  pick('#sk-tools [data-size]', (b) => { size = Number(b.dataset.size); });
  $('#sk-undo').addEventListener('click', () => {
    strokes.pop();
    render();
  });
  $('#sk-clear').addEventListener('click', () => {
    strokes = [];
    render();
  });
  $('#sk-close').addEventListener('click', () => tryClose());
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    tryClose();
  });
  $('#sk-send').addEventListener('click', submit);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const p = point(e);
    drawing = { tool, color, width: size * scale() * (tool === 'eraser' ? 4 : 1), points: [p, p] };
    render();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = point(e);
    if (drawing.tool === 'pen' || drawing.tool === 'eraser') drawing.points.push(p);
    else drawing.points[1] = p;
    render();
  });
  const end = () => {
    if (!drawing) return;
    strokes.push(drawing);
    drawing = null;
    render();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function pick(sel, fn) {
  const btns = [...document.querySelectorAll(sel)];
  for (const b of btns) {
    b.addEventListener('click', () => {
      for (const x of btns) x.classList.toggle('active', x === b);
      fn(b);
    });
  }
}

// opts: { background (ImageBitmap), title, context (câu mô tả gửi kèm) }
export function openSketch(opts = {}) {
  background = opts.background || null;
  context = opts.context || '';
  strokes = [];
  drawing = null;
  titleEl.textContent = opts.title || 'Vẽ phác';
  noteInput.value = '';
  noteInput.placeholder = background ? 'Muốn sửa gì ở chỗ đã khoanh? (tùy chọn)' : 'Mô tả kèm hình vẽ (tùy chọn)';
  dlg.showModal();
  requestAnimationFrame(setup);
}

function setup() {
  const box = wrap.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = background ? background.width : Math.max(300, Math.round(box.width * dpr));
  const h = background ? background.height : Math.max(200, Math.round(box.height * dpr));
  canvas.width = ink.width = w;
  canvas.height = ink.height = h;
  const s = Math.min(box.width / w, box.height / h);
  canvas.style.width = `${Math.floor(w * s)}px`;
  canvas.style.height = `${Math.floor(h * s)}px`;
  render();
}

// px canvas trên mỗi px CSS: nét vẽ trông cùng độ dày dù ảnh to hay nhỏ.
const scale = () => canvas.width / (canvas.getBoundingClientRect().width || canvas.width);

function point(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
}

function drawStroke(c, s) {
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = s.width;
  c.strokeStyle = s.color;
  c.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  const [a, b] = [s.points[0], s.points[s.points.length - 1]];
  c.beginPath();
  if (s.tool === 'rect') {
    c.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  } else if (s.tool === 'arrow') {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const head = Math.max(12, s.width * 4);
    c.moveTo(...a);
    c.lineTo(...b);
    c.moveTo(b[0] - head * Math.cos(ang - 0.45), b[1] - head * Math.sin(ang - 0.45));
    c.lineTo(...b);
    c.lineTo(b[0] - head * Math.cos(ang + 0.45), b[1] - head * Math.sin(ang + 0.45));
    c.stroke();
  } else {
    c.moveTo(...s.points[0]);
    for (const p of s.points.slice(1)) c.lineTo(...p);
    c.stroke();
  }
  c.restore();
}

function render() {
  inkCtx.clearRect(0, 0, ink.width, ink.height);
  for (const s of drawing ? [...strokes, drawing] : strokes) drawStroke(inkCtx, s);
  if (background) ctx.drawImage(background, 0, 0);
  else {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(ink, 0, 0);
}

async function tryClose() {
  if (strokes.length && !(await confirmDialog('Bỏ hình đang vẽ?', 'Bỏ'))) return;
  dlg.close();
}

function submit() {
  const note = noteInput.value.trim();
  const text = [context, note].filter(Boolean).join(': ');
  canvas.toBlob((blob) => {
    if (!blob) return;
    dlg.close();
    onSend(new File([blob], 'sketch.png', { type: 'image/png' }), text);
  }, 'image/png');
}
