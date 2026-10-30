// Đổi chữ có mã màu ANSI (tmux capture-pane -e) thành các <span> có màu, để xem nội dung phiên giống terminal.
// Chỉ xử lý SGR (màu, đậm, mờ, nghiêng, gạch chân, đảo màu); mã điều khiển khác bỏ qua.

// 16 màu cơ bản theo mặc định của xterm.js (cho khớp với terminal trong app).
const BASE = [
  '#2e3436', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

function color256(n) {
  if (n < 16) return BASE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

// Đọc màu mở rộng (38;5;n hoặc 38;2;r;g;b) bắt đầu từ codes[i], trả về [màu, số mã đã dùng].
function extended(codes, i) {
  if (codes[i + 1] === 5) return [color256(codes[i + 2] ?? 0), 3];
  if (codes[i + 1] === 2) return [`rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`, 5];
  return [null, 1];
}

function apply(st, codes) {
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false, under: false, inverse: false });
    else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 3) st.italic = true;
    else if (c === 4) st.under = true;
    else if (c === 7) st.inverse = true;
    else if (c === 22) st.bold = st.dim = false;
    else if (c === 23) st.italic = false;
    else if (c === 24) st.under = false;
    else if (c === 27) st.inverse = false;
    else if (c >= 30 && c <= 37) st.fg = BASE[c - 30];
    else if (c >= 90 && c <= 97) st.fg = BASE[c - 82];
    else if (c === 39) st.fg = null;
    else if (c >= 40 && c <= 47) st.bg = BASE[c - 40];
    else if (c >= 100 && c <= 107) st.bg = BASE[c - 92];
    else if (c === 49) st.bg = null;
    else if (c === 38 || c === 48) {
      const [col, used] = extended(codes, i);
      if (c === 38) st.fg = col;
      else st.bg = col;
      i += used - 1;
    }
  }
}

function css(st) {
  let fg = st.fg;
  let bg = st.bg;
  if (st.inverse) [fg, bg] = [bg || 'var(--term-bg)', fg || 'var(--text)'];
  const out = [];
  if (fg) out.push(`color:${fg}`);
  if (bg) out.push(`background:${bg}`);
  if (st.bold) out.push('font-weight:bold');
  if (st.dim) out.push('opacity:.6');
  if (st.italic) out.push('font-style:italic');
  if (st.under) out.push('text-decoration:underline');
  return out.join(';');
}

// Vẽ text vào phần tử root (xóa nội dung cũ).
export function renderAnsi(root, text) {
  const frag = document.createDocumentFragment();
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false, under: false, inverse: false };
  const re = /\x1b\[([\d;:]*)([A-Za-z])|\x1b[\]P^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b./g;
  let last = 0;
  const push = (s) => {
    if (!s) return;
    const style = css(st);
    if (!style) return frag.append(s);
    const span = document.createElement('span');
    span.style.cssText = style;
    span.textContent = s;
    frag.append(span);
  };
  for (const m of text.matchAll(re)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === 'm') apply(st, m[1] ? m[1].split(/[;:]/).map(Number) : [0]);
  }
  push(text.slice(last));
  root.replaceChildren(frag);
}
