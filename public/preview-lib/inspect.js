// Chèn vào mọi trang trong khung Preview (trang chạy sandbox, chỉ nói chuyện với app qua postMessage).
// Bật chế độ góp ý: rê chuột tô viền phần tử, bấm/chạm thì gửi selector + chữ của phần tử về app để anh ghi góp ý cho Claude.
(() => {
  if (window.parent === window) return;
  const post = (msg) => window.parent.postMessage({ cpm: 1, ...msg }, '*');
  let on = false;
  let box = null;

  function overlay() {
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-cpm', '');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #e8875b;background:rgba(232,135,91,.15);border-radius:3px;transition:all .05s;display:none';
      document.documentElement.append(box);
    }
    return box;
  }

  function highlight(el) {
    const b = overlay();
    if (!el || el === document.documentElement) {
      b.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(b.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  const SIMPLE_CLASS = /^[A-Za-z_-][\w-]{0,30}$/;
  function part(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    let s = el.tagName.toLowerCase();
    const cls = [...el.classList].filter((c) => SIMPLE_CLASS.test(c)).slice(0, 2);
    if (cls.length) s += `.${cls.join('.')}`;
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return s;
  }

  function selectorOf(el) {
    const parts = [];
    for (let cur = el; cur && cur !== document.body && cur !== document.documentElement && parts.length < 5; cur = cur.parentElement) {
      const p = part(cur);
      parts.unshift(p);
      if (p.startsWith('#')) break;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function pick(el) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const tag = el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1);
    const slide = el.closest('body > section');
    post({
      type: 'picked',
      selector: selectorOf(el),
      text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      tag: tag.length > 200 ? `${tag.slice(0, 200)}…` : tag,
      slide: slide ? [...document.querySelectorAll('body > section')].indexOf(slide) + 1 : 0,
    });
  }

  const target = (e) => (e.target instanceof Element && !e.target.hasAttribute('data-cpm') ? e.target : null);
  addEventListener('pointermove', (e) => { if (on) highlight(target(e)); }, true);
  addEventListener('click', (e) => {
    if (!on) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = target(e);
    if (el) pick(el);
  }, true);
  // Đang góp ý thì không để trang nhận phím/nhấn (mở link, gửi form…).
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'submit', 'keydown']) {
    addEventListener(type, (e) => {
      if (!on) return;
      if (type === 'keydown' && e.key === 'Escape') post({ type: 'inspect-cancel' });
      if (type !== 'pointerdown' || e.pointerType !== 'touch') e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data?.cpm) return;
    if (e.data.type === 'inspect') {
      on = !!e.data.on;
      document.documentElement.style.cursor = on ? 'crosshair' : '';
      if (!on) highlight(null);
    }
  });
  post({ type: 'ready' });
})();
