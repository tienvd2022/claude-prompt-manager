// Gợi ý lệnh "/" trong ô prompt: gõ "/" ở đầu ô thì hiện skill, command, lệnh của Claude Code; gõ tiếp để lọc,
// ↑↓ chọn, Enter/Tab chèn, Esc đóng. Chỉ mở khi "/" là ký tự đầu tiên của ô (giống Claude Code).

import { $, el, api, projectUrl } from './common.js';

const CACHE_MS = 60000;
const MAX_ITEMS = 60;

const input = $('#prompt-input');
const menu = $('#slash-menu');

let getContext = () => null; // () => { project, alias } của phiên đang mở, null nếu không phải phiên Claude
let cache = new Map(); // `${project}|${alias}` -> { at, list }
let items = [];
let index = 0;
let open = false;

export function initSlash({ context }) {
  getContext = context;
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(close, 150));
  // Bắt phím trước handler Ctrl+Enter của ô prompt.
  input.addEventListener('keydown', onKey, true);
  // Giữ focus ở ô prompt khi bấm vào menu (không thì bàn phím điện thoại cụp xuống).
  menu.addEventListener('pointerdown', (e) => e.preventDefault());
}

// Chữ đang gõ sau "/" nếu con trỏ còn ở trong từ đầu tiên của ô, không thì null.
function query() {
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  if (!v.startsWith('/')) return null;
  const head = v.slice(1, caret);
  return /\s/.test(head) ? null : head;
}

async function commands() {
  const ctx = getContext();
  if (!ctx) return null;
  const key = `${ctx.project}|${ctx.alias || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const { commands: list } = await api('GET', projectUrl(ctx.project, `/commands?alias=${encodeURIComponent(ctx.alias || '')}`));
  cache.set(key, { at: Date.now(), list });
  return list;
}

// Khớp đầu tên trước, rồi đầu phần sau dấu ":" (plugin:tên), rồi chứa chuỗi, rồi mô tả (gõ từ 3 ký tự);
// cùng hạng thì theo thứ tự server.
function rank(c, q) {
  const n = c.name.toLowerCase();
  if (!q) return 0;
  if (n.startsWith(q)) return 0;
  if (n.split(':').pop().startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  if (q.length >= 3 && c.description.toLowerCase().includes(q)) return 3;
  return -1;
}

let seq = 0;
async function update() {
  const q = query();
  if (q === null) return close();
  const my = ++seq;
  let list;
  try {
    list = await commands();
  } catch {
    return close();
  }
  if (my !== seq || !list) return my === seq && close();
  const lq = q.toLowerCase();
  items = list
    .map((c, i) => ({ c, r: rank(c, lq), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, MAX_ITEMS)
    .map((x) => x.c);
  if (!items.length) return close();
  index = 0;
  render();
}

function render() {
  open = true;
  menu.hidden = false;
  menu.replaceChildren(...items.map((c, i) => el('li', {
    class: i === index ? 'active' : '',
    role: 'option',
    onclick: () => choose(i),
  },
  el('div', { class: 'slash-name' },
    el('b', { text: `/${c.name}` }),
    c.hint ? el('span', { class: 'muted', text: ` ${c.hint}` }) : '',
    el('span', { class: 'slash-src muted small', text: c.source })),
  c.description ? el('div', { class: 'muted small ellipsis', text: c.description }) : '')));
  menu.children[index]?.scrollIntoView({ block: 'nearest' });
}

function close() {
  seq++;
  open = false;
  menu.hidden = true;
}

function choose(i) {
  const c = items[i];
  if (!c) return;
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const rest = v.slice(caret).replace(/^\S*/, '').replace(/^\s*/, '');
  input.value = `/${c.name} ${rest}`;
  const pos = c.name.length + 2;
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event('input')); // lưu nháp, co giãn ô
  close();
  input.focus();
}

function onKey(e) {
  // Safari báo Enter dùng để chốt chữ IME là keydown thường (isComposing=false, keyCode 229): đừng coi là chọn lệnh.
  if (!open || e.isComposing || (e.key === 'Enter' && e.keyCode === 229)) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    render();
  } else if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
    choose(index);
  } else if (e.key === 'Escape') {
    close();
  } else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}
