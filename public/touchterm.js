// Cảm ứng cho terminal trên điện thoại, chỉ 3 thao tác:
// - kéo: cuộn (có quán tính);
// - nhấn giữ: chọn chữ ở chỗ chạm, giữ rồi kéo luôn thì chọn tiếp tới chỗ ngón tay;
// - thả tay ra thì hiện 2 tay kéo ở đầu/cuối vùng chọn để chỉnh lại, và thanh Copy.
// Trình duyệt không được tự cuộn (touch-action: none trong style.css), không thì nó tranh với cuộn ở đây,
// lúc cuộn được lúc không. xterm.js tự cuộn bằng scrollTop rồi làm tròn về dòng gần nhất, nên kéo chậm bị
// kéo ngược lại (khựng): ở đây gom quãng kéo theo pixel, đủ một dòng thì cuộn một dòng, và chặn handler cảm ứng của xterm.

import { el } from './common.js';

const HOLD_MS = 450;
const SLOP = 8; // px: rung tay dưới mức này vẫn tính là nhấn yên
const FRICTION = 0.95; // mỗi khung hình 16ms
const MIN_SPEED = 0.03; // px/ms

export function attachTouch(term, box, { onCopy }) {
  let mode = null; // 'pending' | 'scroll' | 'select' | 'handle'
  let start = null; // { x, y }
  let lastY = 0;
  let acc = 0; // px kéo chưa đủ một dòng
  let samples = []; // [{ y, t }] để tính vận tốc lúc thả tay
  let fling = 0;
  let holdTimer = null;
  let sel = null; // { from, to } (ô trong buffer, from <= to) của vùng đang chọn
  let anchor = null; // chữ chọn lúc nhấn giữ, để kéo tiếp về hai phía
  let dragging = null; // 'from' | 'to': tay kéo đang được kéo
  let grab = { dx: 0, dy: 0 }; // lệch giữa ngón tay và ô của tay kéo lúc bắt đầu kéo

  const bar = el('div', { class: 'term-selbar', hidden: true },
    el('button', { type: 'button', text: 'Copy', onclick: copy }),
    el('button', { type: 'button', text: 'Hết', title: 'Chọn hết', onclick: selectAll }),
    el('button', { type: 'button', text: '✕', title: 'Bỏ chọn', onclick: clearSelection }));
  const handles = {
    from: el('div', { class: 'term-handle from', hidden: true }),
    to: el('div', { class: 'term-handle to', hidden: true }),
  };
  box.append(bar, handles.from, handles.to);

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

  const index = (p) => p.row * term.cols + p.col;

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

  // Chọn từ ô a tới ô b (không cần theo thứ tự).
  function setSelection(a, b) {
    const [from, to] = index(a) <= index(b) ? [a, b] : [b, a];
    sel = { from, to };
    term.select(from.col, from.row, index(to) - index(from) + 1);
    placeHandles();
  }

  // Nhấn giữ: chọn cả chữ (chuỗi không có khoảng trắng) ở chỗ chạm.
  function wordAt({ col, row }) {
    const text = term.buffer.active.getLine(row)?.translateToString(false) || '';
    if (!text[col]?.trim()) return { from: { col, row }, to: { col, row } };
    let a = col;
    let b = col;
    while (a > 0 && text[a - 1].trim()) a--;
    while (b < text.length - 1 && text[b + 1].trim()) b++;
    return { from: { col: a, row }, to: { col: b, row } };
  }

  function beginSelect() {
    holdTimer = null;
    mode = 'select';
    anchor = wordAt(at(start.x, start.y));
    setSelection(anchor.from, anchor.to);
    navigator.vibrate?.(15);
    showTools(false);
  }

  // Tay kéo nằm ngay dưới ô đầu (bên trái) và ô cuối (bên phải) của vùng chọn; cuộn khuất thì ẩn.
  function placeHandles() {
    const show = !!sel && mode !== 'select';
    for (const end of ['from', 'to']) {
      const h = handles[end];
      const p = sel?.[end];
      const vrow = p ? p.row - term.buffer.active.viewportY : -1;
      if (!show || vrow < 0 || vrow >= term.rows) {
        h.hidden = true;
        continue;
      }
      const { r, w, h: ch } = cell();
      const b = box.getBoundingClientRect();
      const left = r.left - b.left + (end === 'from' ? p.col : p.col + 1) * w;
      h.hidden = false;
      // Tay đầu ở sát mép trái thì lật sang phải, không thì bị khuất ngoài màn hình.
      h.classList.toggle('flip', end === 'from' && left < 22);
      h.style.left = `${left}px`;
      h.style.top = `${r.top - b.top + (vrow + 1) * ch}px`;
    }
  }

  function showTools(on) {
    bar.hidden = !on;
    placeHandles();
  }

  function clearSelection() {
    sel = null;
    term.clearSelection();
    showTools(false);
  }

  function selectAll() {
    const last = term.buffer.active.length - 1;
    setSelection({ col: 0, row: 0 }, { col: term.cols - 1, row: last });
  }

  async function copy() {
    const text = term.getSelection();
    if (text) await onCopy(text);
    clearSelection();
  }

  term.onScroll(() => placeHandles());
  term.onRender(() => sel && placeHandles());
  term.onResize(() => clearSelection());
  // xterm tự bỏ chọn (vd nội dung dưới vùng chọn đổi) thì ẩn luôn tay kéo và thanh Copy.
  term.onSelectionChange(() => {
    if (!term.hasSelection() && sel) {
      sel = null;
      showTools(false);
    }
  });

  // Kéo sát mép trên/dưới thì cuộn tiếp để chọn dài hơn một màn hình.
  function edgeScroll(y) {
    const { r, h } = cell();
    if (y < r.top + h) term.scrollLines(-1);
    else if (y > r.bottom - h) term.scrollLines(1);
  }

  box.addEventListener('touchstart', (e) => {
    if (bar.contains(e.target)) return;
    e.stopPropagation();
    stopFling();
    clearTimeout(holdTimer);
    holdTimer = null;
    if (e.touches.length !== 1) {
      mode = null;
      start = null;
      return;
    }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    const end = e.target === handles.from ? 'from' : e.target === handles.to ? 'to' : null;
    if (end && sel) {
      // Nắm tay kéo: nhớ lệch giữa ngón tay và ô, để ô không nhảy lên chỗ ngón tay che.
      e.preventDefault();
      mode = 'handle';
      dragging = end;
      const { r, w, h } = cell();
      const p = sel[end];
      grab = {
        dx: t.clientX - (r.left + (p.col + 0.5) * w),
        dy: t.clientY - (r.top + (p.row - term.buffer.active.viewportY + 0.5) * h),
      };
      return;
    }
    mode = 'pending';
    lastY = t.clientY;
    acc = 0;
    samples = [{ y: t.clientY, t: e.timeStamp }];
    if (sel) clearSelection();
    holdTimer = setTimeout(beginSelect, HOLD_MS);
  }, { capture: true, passive: false });

  box.addEventListener('touchmove', (e) => {
    if (!start || bar.contains(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    const t = e.touches[0];
    if (mode === 'handle') {
      edgeScroll(t.clientY);
      const p = at(t.clientX - grab.dx, t.clientY - grab.dy);
      const other = dragging === 'from' ? sel.to : sel.from;
      setSelection(p, other);
      // Kéo tay đầu vượt qua tay cuối (hoặc ngược lại) thì đổi vai.
      dragging = index(p) <= index(other) ? 'from' : 'to';
      return;
    }
    if (mode === 'select') {
      edgeScroll(t.clientY);
      const p = at(t.clientX, t.clientY);
      if (index(p) >= index(anchor.from)) setSelection(anchor.from, index(p) > index(anchor.to) ? p : anchor.to);
      else setSelection(p, anchor.to);
      return;
    }
    if (mode === 'pending') {
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) < SLOP) return;
      clearTimeout(holdTimer);
      holdTimer = null;
      mode = 'scroll';
    }
    if (mode !== 'scroll') return;
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
    const was = mode;
    mode = null;
    start = null;
    dragging = null;
    if (was === 'select' || was === 'handle') {
      e.preventDefault(); // không để chạm này thành click (bật bàn phím, bỏ chọn)
      if (term.hasSelection()) showTools(true);
      else clearSelection();
    } else if (was === 'scroll') {
      e.preventDefault();
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt > 0 && e.timeStamp - last.t < 80) startFling((first.y - last.y) / dt);
    }
    // 'pending' (chạm nhẹ) thì để thành click như bình thường: focus terminal, bật bàn phím.
  };
  box.addEventListener('touchend', end, { capture: true, passive: false });
  box.addEventListener('touchcancel', end, { capture: true, passive: false });
  // Nhấn giữ trên Android bắn contextmenu; xterm bắt nó để focus ô nhập ẩn, làm bật bàn phím.
  box.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true });
}
