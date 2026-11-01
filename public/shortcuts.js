// Phím tắt: danh sách hành động + phím mặc định, đọc/ghi ở data/settings.json trên server
// (mục "shortcuts"), màn sửa phím, import/export. app.js đăng ký việc cần làm cho từng hành động.

import { $, el, api, toast, nativeApp, copyText } from './common.js';

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

// scope: projects (màn danh sách), workspace (trong dự án), global (cả hai).
// typing: được chạy cả khi đang gõ trong ô nhập (phím có Cmd/Ctrl/Alt thì luôn chạy, không cần cờ này).
const G = {
  global: 'Chung',
  tabs: 'Phiên Claude (tab)',
  sidebar: 'Sidebar: Phiên / File / Git',
  prompt: 'Ô prompt',
  projects: 'Danh sách dự án',
};

const digits = (n, fn) => Array.from({ length: n }, (_, i) => fn(i + 1));

export const ACTIONS = [
  { id: 'shortcuts.edit', group: 'global', scope: 'global', label: 'Mở màn phím tắt', keys: ['Mod+,'] },

  ...digits(9, (n) => ({ id: `tab.${n}`, group: 'tabs', scope: 'workspace', label: `Chuyển tới tab ${n}`, keys: [`Mod+${n}`] })),
  { id: 'tab.next', group: 'tabs', scope: 'workspace', label: 'Tab kế tiếp', keys: ['Mod+Alt+ArrowRight'] },
  { id: 'tab.prev', group: 'tabs', scope: 'workspace', label: 'Tab phía trước', keys: ['Mod+Alt+ArrowLeft'] },
  { id: 'tab.close', group: 'tabs', scope: 'workspace', label: 'Ẩn tab hiện tại (phiên vẫn chạy)', keys: ['Mod+Alt+W'] },
  { id: 'session.new', group: 'tabs', scope: 'workspace', label: 'Mở phiên mới', keys: ['Mod+Alt+T'] },
  { id: 'terminal.focus', group: 'tabs', scope: 'workspace', label: 'Focus terminal', keys: ['Mod+Alt+K'] },
  { id: 'preview.toggle', group: 'tabs', scope: 'workspace', label: 'Bật/tắt khung Preview', keys: ['Mod+Alt+V'] },
  { id: 'project.back', group: 'tabs', scope: 'workspace', label: 'Về danh sách dự án', keys: ['Mod+Alt+P'] },

  { id: 'sidebar.toggle', group: 'sidebar', scope: 'workspace', label: 'Ẩn/hiện sidebar', keys: ['Mod+B'] },
  { id: 'sidebar.focus', group: 'sidebar', scope: 'workspace', label: 'Focus sidebar', keys: ['Mod+Shift+E'] },
  { id: 'panel.sessions', group: 'sidebar', scope: 'workspace', label: 'Sang panel Phiên', keys: ['Mod+Alt+1'] },
  { id: 'panel.files', group: 'sidebar', scope: 'workspace', label: 'Sang panel File', keys: ['Mod+Alt+2'] },
  { id: 'panel.git', group: 'sidebar', scope: 'workspace', label: 'Sang panel Git', keys: ['Mod+Alt+3'] },
  { id: 'panel.next', group: 'sidebar', scope: 'workspace', label: 'Panel kế tiếp (Phiên → File → Git)', keys: ['Mod+Shift+]'] },
  { id: 'panel.prev', group: 'sidebar', scope: 'workspace', label: 'Panel phía trước', keys: ['Mod+Shift+['] },

  { id: 'prompt.focus', group: 'prompt', scope: 'workspace', label: 'Focus ô prompt', keys: ['Mod+I'] },
  { id: 'prompt.send', group: 'prompt', scope: 'workspace', label: 'Gửi prompt', keys: ['Mod+Enter'] },
  { id: 'prompt.queue', group: 'prompt', scope: 'workspace', label: 'Xếp prompt vào hàng đợi (ô trống: mở hàng đợi)', keys: ['Mod+Shift+Enter'] },
  { id: 'queue.show', group: 'prompt', scope: 'workspace', label: 'Mở hàng đợi prompt', keys: ['Mod+Alt+Q'] },
  { id: 'history.show', group: 'prompt', scope: 'workspace', label: 'Mở lịch sử prompt', keys: ['Mod+Alt+H'] },

  { id: 'projects.filter', group: 'projects', scope: 'projects', label: 'Focus ô tìm dự án', keys: ['/', 'Mod+K'] },
  { id: 'projects.next', group: 'projects', scope: 'projects', typing: true, label: 'Dự án bên dưới', keys: ['ArrowDown'] },
  { id: 'projects.prev', group: 'projects', scope: 'projects', typing: true, label: 'Dự án bên trên (từ dự án đầu về ô tìm)', keys: ['ArrowUp'] },
  { id: 'projects.open', group: 'projects', scope: 'projects', typing: true, label: 'Mở dự án đầu danh sách (khi đang ở ô tìm)', keys: ['Enter'] },
  { id: 'projects.new', group: 'projects', scope: 'projects', label: 'Dự án mới', keys: ['Mod+Alt+N'] },
  { id: 'projects.folder', group: 'projects', scope: 'projects', label: 'Mở thư mục bất kỳ', keys: ['Mod+O'] },
  ...digits(9, (n) => ({ id: `projects.open.${n}`, group: 'projects', scope: 'projects', label: `Mở dự án thứ ${n} trong danh sách`, keys: [`Alt+${n}`] })),
];

// ---------- Tổ hợp phím ----------

const PUNCT = { '/': 'Slash', ',': 'Comma', '.': 'Period', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote' };
const NAMED = { enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
const CODE_NAME = Object.fromEntries([...Object.entries(PUNCT).map(([k, v]) => [v, k]), ['Enter', 'Enter'], ['Escape', 'Escape'], ['Tab', 'Tab'], ['Space', 'Space'], ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['ArrowUp', 'ArrowUp'], ['ArrowDown', 'ArrowDown'], ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'], ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown']]);
const SHOW = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '⏎', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', Space: 'Space' };

function keyToCode(key) {
  const k = key.trim();
  if (/^[a-z]$/i.test(k)) return `Key${k.toUpperCase()}`;
  if (/^\d$/.test(k)) return `Digit${k}`;
  if (/^f([1-9]|1[0-2])$/i.test(k)) return k.toUpperCase();
  if (PUNCT[k]) return PUNCT[k];
  return NAMED[k.toLowerCase()] || null;
}

// "Mod+Shift+K" -> { ctrl, meta, alt, shift, code } hoặc null nếu không hiểu.
export function parseCombo(str) {
  if (typeof str !== 'string') return null;
  const parts = str.split('+');
  // "Mod+," hay "Mod++": phần tử cuối rỗng nghĩa là phím chính là dấu "+" (không hỗ trợ), còn dấu "," vẫn tách đúng.
  const keyPart = parts.pop();
  const c = { ctrl: false, meta: false, alt: false, shift: false, code: keyToCode(keyPart || '') };
  if (!c.code) return null;
  for (const m of parts) {
    switch (m.trim().toLowerCase()) {
      case 'mod': c[isMac ? 'meta' : 'ctrl'] = true; break;
      case 'cmd': case 'command': case 'meta': case 'super': c.meta = true; break;
      case 'ctrl': case 'control': c.ctrl = true; break;
      case 'alt': case 'option': case 'opt': c.alt = true; break;
      case 'shift': c.shift = true; break;
      default: return null;
    }
  }
  return c;
}

const comboId = (c) => `${c.ctrl ? 'C' : ''}${c.meta ? 'M' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}+${c.code}`;

// Chuỗi lưu vào settings.json từ một phím vừa nhấn.
function eventToString(e) {
  const name = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d+$/.test(e.code) ? e.code : CODE_NAME[e.code];
  if (!name) return null;
  const mods = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (isMac && e.ctrlKey) mods.push('Ctrl');
  if (!isMac && e.metaKey) mods.push('Meta');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, name].join('+');
}

export function prettyCombo(str) {
  const c = parseCombo(str);
  if (!c) return str;
  const key = /^Key/.test(c.code) ? c.code.slice(3) : /^Digit/.test(c.code) ? c.code.slice(5) : CODE_NAME[c.code] ? (SHOW[c.code] || CODE_NAME[c.code]) : c.code;
  if (isMac) return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${key}`;
  return [c.ctrl && 'Ctrl', c.meta && 'Win', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}

// ---------- Cài đặt ----------

let settings = {}; // toàn bộ settings.json (giữ cả mục lạ để không mất khi lưu)
let bindings = []; // [{ action, combo }]
let handlers = {};
let invalid = []; // chuỗi phím không hiểu, hiện trong màn sửa
let ctx = { view: () => 'workspace' };

function userValue(id) {
  const v = settings.shortcuts?.[id];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  return typeof v === 'string' && v.trim() ? [v] : []; // null / "" / false: tắt phím
}

export const keysOf = (def) => userValue(def.id) ?? def.keys;

function rebuild() {
  bindings = [];
  invalid = [];
  for (const def of ACTIONS) {
    for (const s of keysOf(def)) {
      const combo = parseCombo(s);
      if (combo) bindings.push({ def, combo });
      else invalid.push(`${def.id}: "${s}"`);
    }
  }
}

export const shortcutLabel = (id) => {
  const def = ACTIONS.find((a) => a.id === id);
  const k = def && keysOf(def)[0];
  return k ? prettyCombo(k) : '';
};

// settings.json đầy đủ: mọi hành động kèm phím đang dùng (để export / sửa tay cho dễ).
function fullSettings() {
  const shortcuts = {};
  for (const def of ACTIONS) shortcuts[def.id] = keysOf(def);
  return { ...settings, shortcuts };
}

async function save(next) {
  settings = await api('PUT', '/api/settings', next);
  rebuild();
  onChange?.();
}

let onChange = null;

// ---------- Bắt phím ----------

const editable = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
let recording = null; // { id, done }

function onKey(e) {
  if (e.isComposing) return;
  if (recording) return recordKey(e);
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const view = ctx.view();
  const modal = document.querySelector('dialog[open]');
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  for (const { def, combo } of bindings) {
    if (combo.code !== e.code || combo.ctrl !== e.ctrlKey || combo.meta !== e.metaKey || combo.alt !== e.altKey || combo.shift !== e.shiftKey) continue;
    if (def.scope !== 'global' && def.scope !== view) continue;
    if (modal && def.scope !== 'global') continue;
    if (plain && editable(e.target) && !def.typing) continue;
    if (e.repeat && !def.typing) continue;
    const fn = handlers[def.id];
    if (!fn) continue;
    if (fn(e) === false) continue; // không xử lý: để phím chạy như bình thường
    e.preventDefault();
    e.stopPropagation();
    return;
  }
}

// ---------- Màn sửa phím ----------

const dlg = () => $('#dlg-shortcuts');

function conflicts() {
  const seen = new Map();
  const bad = new Set();
  for (const { def, combo } of bindings) {
    const id = comboId(combo);
    for (const other of seen.get(id) || []) {
      if (other.scope === def.scope || other.scope === 'global' || def.scope === 'global') {
        bad.add(other.id);
        bad.add(def.id);
      }
    }
    seen.set(id, [...(seen.get(id) || []), def]);
  }
  return bad;
}

function renderDialog() {
  const bad = conflicts();
  const list = $('#sc-list');
  list.replaceChildren();
  let group = null;
  for (const def of ACTIONS) {
    if (def.group !== group) {
      group = def.group;
      list.append(el('h3', { text: G[group] }));
    }
    const keys = keysOf(def);
    const isRec = recording?.id === def.id;
    const custom = userValue(def.id) !== undefined && JSON.stringify(keys) !== JSON.stringify(def.keys);
    list.append(el('div', { class: `sc-row${bad.has(def.id) ? ' conflict' : ''}` },
      el('span', { class: 'sc-label', text: def.label, title: def.id }),
      el('button', {
        type: 'button',
        class: `sc-key${isRec ? ' recording' : ''}${custom ? ' custom' : ''}`,
        title: bad.has(def.id) ? 'Trùng với phím của hành động khác' : 'Bấm rồi nhấn tổ hợp phím mới',
        text: isRec ? 'Nhấn phím… (Esc hủy, ⌫ bỏ phím)' : keys.length ? keys.map(prettyCombo).join('  /  ') : 'Chưa gán',
        onclick: () => startRecording(def.id),
      }),
      el('button', { type: 'button', class: 'icon-btn small', title: 'Về phím mặc định', 'aria-label': 'Về phím mặc định', text: '↺', disabled: !custom, onclick: () => setKeys(def.id, undefined) })));
  }
  $('#sc-json').value = JSON.stringify(fullSettings(), null, 2);
  $('#sc-error').textContent = invalid.length ? `Không hiểu phím: ${invalid.join(', ')}` : '';
}

function startRecording(id) {
  recording = { id };
  renderDialog();
}

function recordKey(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  const id = recording.id;
  recording = null;
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) return renderDialog();
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey) return setKeys(id, []);
  const str = eventToString(e);
  if (!str) {
    toast('Phím này chưa hỗ trợ', 'error');
    return renderDialog();
  }
  setKeys(id, [str]);
}

async function setKeys(id, keys) {
  const shortcuts = { ...(settings.shortcuts || {}) };
  if (keys === undefined) delete shortcuts[id];
  else shortcuts[id] = keys;
  try {
    await save({ ...settings, shortcuts });
  } catch (err) {
    toast(err.message, 'error');
  }
  renderDialog();
}

export function openShortcuts() {
  recording = null;
  renderDialog();
  if (!dlg().open) dlg().showModal();
}

function exportSettings() {
  const text = `${JSON.stringify(fullSettings(), null, 2)}\n`;
  // Trong app mobile không tải blob được: chép vào clipboard để dán đi đâu cũng được.
  if (nativeApp) {
    copyText(text).then((ok) => toast(ok ? 'Đã copy settings.json' : 'Không copy được, mở "Sửa JSON" để copy tay', ok ? undefined : 'error'));
    return;
  }
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: 'settings.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function applyText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON sai: ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('settings.json phải là một object { "shortcuts": { … } }');
  if (data.shortcuts !== undefined && (typeof data.shortcuts !== 'object' || data.shortcuts === null || Array.isArray(data.shortcuts))) throw new Error('"shortcuts" phải là object { "tab.1": "Mod+1", … }');
  await save(data);
  renderDialog();
}

function initDialog() {
  $('#sc-apply').addEventListener('click', async () => {
    try {
      await applyText($('#sc-json').value);
      toast('Đã áp dụng');
    } catch (err) {
      $('#sc-error').textContent = err.message;
    }
  });
  $('#sc-export').addEventListener('click', exportSettings);
  $('#sc-import').addEventListener('click', () => $('#sc-file').click());
  $('#sc-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await applyText(await file.text());
      toast('Đã import settings.json');
    } catch (err) {
      $('#sc-error').textContent = err.message;
    }
  });
  $('#sc-reset').addEventListener('click', async () => {
    const { shortcuts, ...rest } = settings; // eslint-disable-line no-unused-vars
    try {
      await save(rest);
    } catch (err) {
      toast(err.message, 'error');
    }
    renderDialog();
  });
  dlg().addEventListener('close', () => { recording = null; });
  // Esc khi đang bắt phím chỉ hủy việc bắt, không đóng dialog.
  dlg().addEventListener('cancel', (e) => {
    if (recording) e.preventDefault();
  });
}

export async function initShortcuts({ actions, view, onChange: cb }) {
  handlers = actions;
  ctx = { view };
  onChange = cb;
  rebuild();
  window.addEventListener('keydown', onKey, true);
  initDialog();
  try {
    settings = await api('GET', '/api/settings');
  } catch {
    settings = {};
  }
  rebuild();
  onChange?.();
}
