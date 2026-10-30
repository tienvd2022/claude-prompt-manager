// Cảm ứng cho terminal trên điện thoại: kéo để cuộn (có quán tính), nhấn giữ để chọn chữ rồi copy.
// xterm.js tự cuộn bằng scrollTop rồi làm tròn về dòng gần nhất, nên kéo chậm bị kéo ngược lại (khựng).
// Ở đây gom quãng kéo theo pixel, đủ một dòng thì cuộn một dòng, và chặn handler cảm ứng của xterm.

import { el } from './common.js';

const HOLD_MS = 450;
const SLOP = 8; // px: rung tay dưới mức này vẫn tính là nhấn yên
const FRICTION = 0.95; // mỗi khung hình 16ms
const MIN_SPEED = 0.03; // px/ms

export function attachTouch(term, box, { onCopy }) {
  let start = null; // { x, y, time }
  let lastY = 0;
  let acc = 0; // px kéo chưa đủ một dòng
  let samples = []; // [{ y, t }] để tính vận tốc lúc thả tay
  let fling = 0;
  let holdTimer = null;
  let selecting = null; // { anchor } khi đang chọn chữ
  let scrolled = false;

  const bar = el('div', { class: 'term-selbar', hidden: true },
    el('button', { type: 'button', text: 'Copy', onclick: copy }),
    el('button', { type: 'button', text: 'Hết', title: 'Chọn hết', onclick: () => term.selectAll() }),
    el('button', { type: 'button', text: '✕', title: 'Bỏ chọn', onclick: clearSelection }));
  box.append(bar);

  function cell() {
    const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    return { r, w: r.width / term.cols, h: r.height / term.rows };
  }

  // Vị trí chạm -> ô trong buffer (dòng tính cả phần đã cuộn).
  function at(x, y) {
    const { r, w, h } = cell();
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - r.left) / w)));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - r.top) / h)));
    return { col, row: term.buffer.active.viewportY + row };
  }

  function scrollBy(px) {
    acc += px;
    const h = cell().h;
    const lines = Math.trunc(acc / h);
    if (!lines) return true;
    acc -= lines * h;
    const before = term.buffer.active.viewportY;
    term.scrollLines(lines);
    return term.buffer.active.viewportY !== before;
  }

  function stopFling() {
    cancelAnimationFrame(fling);
    fling = 0;
  }

  function startFling(v) {
    let t0 = performance.now();
    const step = (t) => {
      const dt = Math.min(48, t - t0);
      t0 = t;
      v *= FRICTION ** (dt / 16);
      if (Math.abs(v) < MIN_SPEED || !scrollBy(v * dt)) return stopFling();
      fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  }

  function selectRange(a, b) {
    const ia = a.row * term.cols + a.col;
    const ib = b.row * term.cols + b.col;
    const s = Math.min(ia, ib);
    term.select(s % term.cols, Math.floor(s / term.cols), Math.abs(ib - ia) + 1);
  }

  // Nhấn giữ: chọn cả chữ (chuỗi không có khoảng trắng) ở chỗ chạm.
  function selectWord({ col, row }) {
    const text = term.buffer.active.getLine(row)?.translateToString(false) || '';
    if (!text[col]?.trim()) return { anchor: { col, row }, from: { col, row }, to: { col, row } };
    let a = col;
    let b = col;
    while (a > 0 && text[a - 1].trim()) a--;
    while (b < text.length - 1 && text[b + 1].trim()) b++;
    return { anchor: { col: a, row }, from: { col: a, row }, to: { col: b, row } };
  }

  function beginSelect() {
    holdTimer = null;
    const word = selectWord(at(start.x, start.y));
    selecting = word;
    selectRange(word.from, word.to);
    navigator.vibrate?.(15);
    showBar(false);
  }

  function showBar(on) {
    bar.hidden = !on;
  }

  function clearSelection() {
    term.clearSelection();
    showBar(false);
  }

  async function copy() {
    const text = term.getSelection();
    if (text) await onCopy(text);
    clearSelection();
  }

  box.addEventListener('touchstart', (e) => {
    if (bar.contains(e.target)) return;
    e.stopPropagation();
    stopFling();
    if (e.touches.length !== 1) {
      clearTimeout(holdTimer);
      start = null;
      return;
    }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    lastY = t.clientY;
    acc = 0;
    scrolled = false;
    samples = [{ y: t.clientY, t: e.timeStamp }];
    if (term.hasSelection()) clearSelection();
    holdTimer = setTimeout(beginSelect, HOLD_MS);
  }, { capture: true, passive: true });

  box.addEventListener('touchmove', (e) => {
    if (!start || bar.contains(e.target)) return;
    e.stopPropagation();
    const t = e.touches[0];
    if (selecting) {
      e.preventDefault();
      // Kéo sát mép trên/dưới thì cuộn tiếp để chọn dài hơn một màn hình.
      const { r, h } = cell();
      if (t.clientY < r.top + h) term.scrollLines(-1);
      else if (t.clientY > r.bottom - h) term.scrollLines(1);
      const p = at(t.clientX, t.clientY);
      const { anchor, to } = selecting;
      const ia = anchor.row * term.cols + anchor.col;
      const ip = p.row * term.cols + p.col;
      if (ip >= ia) selectRange(anchor, ip > to.row * term.cols + to.col ? p : to);
      else selectRange(p, to);
      return;
    }
    if (!scrolled && Math.hypot(t.clientX - start.x, t.clientY - start.y) < SLOP) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    scrolled = true;
    e.preventDefault();
    scrollBy(lastY - t.clientY);
    lastY = t.clientY;
    samples.push({ y: t.clientY, t: e.timeStamp });
    if (samples.length > 5) samples.shift();
  }, { capture: true, passive: false });

  const end = (e) => {
    if (!start || bar.contains(e.target)) return;
    e.stopPropagation();
    clearTimeout(holdTimer);
    holdTimer = null;
    if (selecting) {
      e.preventDefault(); // không để chạm này thành click (bật bàn phím, bỏ chọn)
      selecting = null;
      if (term.hasSelection()) showBar(true);
    } else if (scrolled) {
      e.preventDefault();
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt > 0 && e.timeStamp - last.t < 80) startFling((first.y - last.y) / dt);
    }
    start = null;
  };
  box.addEventListener('touchend', end, { capture: true, passive: false });
  box.addEventListener('touchcancel', end, { capture: true, passive: false });
  // Nhấn giữ trên Android bắn contextmenu; xterm bắt nó để focus ô nhập ẩn, làm bật bàn phím.
  box.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true });
}
