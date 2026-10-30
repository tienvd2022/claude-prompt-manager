// Tài khoản git của server: các alias trong ~/.ssh/config, mỗi alias một SSH key (vd github.com-tienvd2022).
// Dùng ở ⚙ Cài đặt Git (xem/copy public key, thêm alias, token), form tạo dự án và đổi origin.

import { $, el, api, toast, inputDialog, copyText } from './common.js';

let listPromise = null;
const checks = new Map(); // alias -> Promise<{ login, provider, message, token }>

export function accounts(force = false) {
  if (force || !listPromise) {
    listPromise = api('GET', '/api/git/accounts').then((r) => r.accounts);
    listPromise.catch(() => { listPromise = null; });
  }
  return listPromise;
}

// Dò key của alias đang vào được tài khoản nào (ssh -T), có token để tạo repo không.
export function checkAccount(alias, force = false) {
  if (force || !checks.has(alias)) {
    const p = api('GET', `/api/git/accounts/${encodeURIComponent(alias)}/check`);
    p.catch(() => checks.delete(alias));
    checks.set(alias, p);
  }
  return checks.get(alias);
}

// Tách URL git thành host + đường dẫn repo: git@host:a/b.git, ssh://git@host/a/b.git, https://host/a/b.git.
function parseUrl(url) {
  const s = url.trim();
  let m = s.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (m) return { host: m[1], path: m[2] };
  m = s.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  return m ? { host: m[1], path: m[2].replace(/^\//, '') } : null;
}

// Đổi URL sang đi qua alias của tài khoản: git@github.com:a/b.git -> git@github.com-tienvd2022:a/b.git.
export function aliasUrl(url, acc) {
  const u = parseUrl(url);
  if (!u || !acc) return url.trim();
  return `${acc.user && acc.user !== 'git' ? acc.alias : `git@${acc.alias}`}:${u.path}`;
}

export function urlHost(url) {
  return parseUrl(url)?.host || '';
}

export function fillAccountSelect(select, list, { none, value = '' } = {}) {
  const opts = none ? [el('option', { value: '', text: none })] : [];
  for (const a of list) opts.push(el('option', { value: a.alias, text: a.hostname === a.alias ? a.alias : `${a.alias} (${a.hostname})` }));
  select.replaceChildren(...opts);
  select.value = list.some((a) => a.alias === value) ? value : (none ? '' : list[0]?.alias || '');
}

export function whoText(info) {
  if (!info) return 'đang dò…';
  if (!info.login) return `✗ chưa vào được (${info.message || 'không rõ'}). Đã add public key vào tài khoản chưa?`;
  const token = info.provider !== 'github' ? '' : info.token === 'gh' ? ' · token: gh' : info.token === 'saved' ? ' · token: đã lưu' : ' · chưa có token (cần khi tạo repo)';
  return `✓ ${info.login}${token}`;
}

// ---------- ⚙ Cài đặt Git: danh sách tài khoản ----------

const listEl = $('#git-accounts');
const errEl = $('#git-settings-error');

export async function renderAccounts() {
  listEl.replaceChildren(el('li', { class: 'muted small', text: 'Đang đọc ~/.ssh/config…' }));
  let list;
  try {
    list = await accounts(true);
  } catch (err) {
    listEl.replaceChildren(el('li', { class: 'error', text: err.message }));
    return;
  }
  listEl.replaceChildren(...list.map(accountItem));
}

function accountItem(a) {
  const who = el('div', { class: 'muted small break', text: a.keyExists ? 'đang dò…' : 'Chưa có file key' });
  const keyBox = el('div', { class: 'acct-key', hidden: true });
  const actions = el('div', { class: 'acct-actions' });
  const li = el('li', { class: 'acct' },
    el('div', { class: 'acct-head' }, el('b', { class: 'ellipsis', text: a.alias }), a.hostname !== a.alias ? el('span', { class: 'muted small', text: a.hostname }) : null),
    who, actions, keyBox);

  if (!a.keyExists) {
    actions.append(el('button', { type: 'button', text: 'Tạo key', onclick: async () => {
      try {
        li.replaceWith(accountItem(await api('POST', `/api/git/accounts/${encodeURIComponent(a.alias)}/key`)));
        accounts(true);
      } catch (err) {
        errEl.textContent = err.message;
      }
    } }));
    return li;
  }

  const ta = el('textarea', { rows: 3, readonly: true });
  ta.value = a.publicKey || '(không đọc được file .pub)';
  keyBox.append(ta, el('button', { type: 'button', text: 'Copy', onclick: async () => {
    const ok = await copyText(ta.value);
    if (ok) toast('Đã copy public key');
    else ta.select();
  } }));
  actions.append(el('button', { type: 'button', text: 'Public key', onclick: () => { keyBox.hidden = !keyBox.hidden; } }));
  const recheck = el('button', { type: 'button', text: 'Kiểm tra', title: 'Thử ssh -T xem key vào được tài khoản nào', onclick: () => refresh(true) });
  actions.append(recheck);

  let tokenBtn = null;
  async function refresh(force) {
    who.textContent = 'đang dò…';
    let info;
    try {
      info = await checkAccount(a.alias, force);
    } catch (err) {
      who.textContent = err.message;
      return;
    }
    who.textContent = whoText(info);
    tokenBtn?.remove();
    tokenBtn = null;
    if (info.login && info.provider === 'github') {
      tokenBtn = el('button', { type: 'button', text: 'Token', title: 'Token GitHub để tạo repo mới (không cần nếu đã đăng nhập gh trên server)', onclick: () => editToken(info.login).then((ok) => ok && refresh(true)) });
      actions.append(tokenBtn);
    }
  }
  refresh(false);
  return li;
}

async function editToken(login) {
  const tok = await inputDialog(`Token GitHub của ${login} (quyền repo; để trống để xóa)`, '', 'Lưu');
  if (tok === null) return false;
  try {
    await api('POST', '/api/git/tokens', { login, token: tok });
    toast(tok ? 'Đã lưu token' : 'Đã xóa token');
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

export function initGitAccounts() {
  $('#acct-add').addEventListener('click', async () => {
    const alias = $('#acct-alias').value.trim();
    if (!alias) return $('#acct-alias').focus();
    errEl.textContent = '';
    try {
      const a = await api('POST', '/api/git/accounts', { alias, hostname: $('#acct-host').value.trim() || 'github.com' });
      $('#acct-alias').value = '';
      accounts(true);
      const item = accountItem(a);
      listEl.append(item);
      $('.acct-key', item).hidden = false; // hiện key ngay để đem đi add vào GitHub
      toast(`Đã tạo key cho ${a.alias}, copy public key add vào tài khoản GitHub tương ứng`);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}
