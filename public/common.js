// Tiện ích dùng chung cho các màn hình.

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// Có dialog đang mở thì gắn class modal-open lên <html> (style.css khóa cuộn trang phía sau).
new MutationObserver(() => {
  document.documentElement.classList.toggle('modal-open', !!document.querySelector('dialog[open]'));
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

// Đang chạy trong app mobile (mobile/, WebView) thì gửi được tin nhắn sang phần native.
export const nativeApp = window.ReactNativeWebView && window.CPM_APP
  ? { ...window.CPM_APP, post: (msg) => window.ReactNativeWebView.postMessage(JSON.stringify(msg)) }
  : null;

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // trình duyệt chặn storage thì bỏ qua
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // như trên
    }
  },
};

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Chưa đăng nhập');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

export const projectUrl = (project, rest = '') => `/api/projects/${encodeURIComponent(project)}${rest}`;

export function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const isTouch = matchMedia('(pointer: coarse)').matches;
export const isNarrow = () => matchMedia('(max-width: 760px)').matches;

// Điện thoại (dialog là bottom sheet): chạm vào vùng tối phía trên sheet thì đóng, đi qua sự kiện cancel như phím Esc
// để dialog nào cần hỏi trước khi bỏ (vd vẽ phác) vẫn hỏi được.
document.addEventListener('click', (e) => {
  const dlg = e.target;
  if (!(dlg instanceof HTMLDialogElement) || !dlg.open || !isNarrow()) return;
  const r = dlg.getBoundingClientRect();
  if (e.clientY >= r.top) return;
  if (dlg.requestClose) dlg.requestClose();
  else if (dlg.dispatchEvent(new Event('cancel', { cancelable: true }))) dlg.close();
});

// ---------- Thông báo nhanh ----------

let toastTimer = null;
export function toast(text, kind = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : 3000);
}

// ---------- Hộp thoại dùng chung ----------

export function confirmDialog(text, okLabel = 'Đồng ý', danger = true) {
  const dlg = $('#dlg-confirm');
  $('#confirm-text', dlg).textContent = text;
  const ok = $('#confirm-ok', dlg);
  ok.textContent = okLabel;
  ok.className = danger ? 'danger-btn' : 'primary-btn';
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

export function inputDialog(title, value = '', okLabel = 'OK') {
  const dlg = $('#dlg-input');
  const form = $('form', dlg);
  $('h2', dlg).textContent = title;
  $('#input-ok', dlg).textContent = okLabel;
  form.value.value = value;
  dlg.returnValue = '';
  dlg.showModal();
  // Chọn phần tên trước đuôi file cho dễ sửa.
  const dot = value.lastIndexOf('.');
  form.value.setSelectionRange(0, dot > 0 ? dot : value.length);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? form.value.value.trim() : null), { once: true });
  });
}

// Hiện văn bản dài (diff, commit). Dòng diff được tô màu.
export function showText(title, text) {
  const dlg = $('#dlg-view');
  $('h2', dlg).textContent = title;
  renderDiff($('pre', dlg), text);
  dlg.showModal();
}

export function renderDiff(pre, text) {
  pre.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) {
    let cls = '';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (/^(diff |commit |index |\+\+\+ |--- )/.test(line)) cls = 'meta';
    frag.append(el('span', { class: cls, text: line + '\n' }));
  }
  pre.append(frag);
  pre.scrollTop = 0;
}

// git in tiến độ bằng \r: chỉ giữ trạng thái cuối của mỗi dòng.
export function cleanProgress(text) {
  return text.split('\n').map((line) => line.split('\r').filter(Boolean).pop() || '').join('\n').trim();
}

// Chạy một lệnh git nền và cập nhật output vào phần tử pre (nếu có) cho tới khi xong.
export async function followJob(job, pre) {
  if (pre) pre.hidden = false;
  for (;;) {
    if (pre) {
      pre.textContent = `$ git ${job.kind}\n${cleanProgress(job.output)}`;
      pre.scrollTop = pre.scrollHeight;
    }
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 800));
    job = (await api('GET', `/api/jobs/${job.id}`)).job;
  }
}

export async function copyText(text) {
  // navigator.clipboard chỉ có trên HTTPS/localhost; mở qua IP LAN thì dùng cách cũ.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    ta.value = text;
    // Đang mở dialog thì phải gắn vào trong nó, không thì không chọn được chữ.
    (document.querySelector('dialog[open]') || document.body).append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
