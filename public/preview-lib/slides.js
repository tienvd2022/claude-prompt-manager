// Trình chiếu đơn giản cho slide Claude viết bằng HTML: mỗi <section> con của <body> là một slide 1280×720.
// Tự co theo khung nhìn, chuyển slide bằng phím mũi tên / vuốt / nút dưới đáy, ⛶ toàn màn hình.
// Khi in (hoặc app xuất PDF) thì mỗi slide một trang đúng khổ.
(() => {
  const W = 1280;
  const H = 720;
  const style = document.createElement('style');
  style.textContent = `
    html, body { margin: 0; height: 100%; overflow: hidden; background: #111; }
    body > section { position: absolute; left: 50%; top: 50%; width: ${W}px; height: ${H}px; box-sizing: border-box; overflow: hidden; display: none; transform-origin: center; }
    :where(body > section) { background: #fff; color: #111; padding: 64px; font: 28px/1.4 system-ui, sans-serif; }
    body > section.cpm-on { display: block; }
    .cpm-bar { position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 2147483646; display: flex; gap: 4px; align-items: center;
      padding: 4px; border-radius: 999px; background: rgba(20, 20, 20, .75); color: #eee; font: 13px system-ui, sans-serif; transition: opacity .3s; }
    .cpm-bar.cpm-hide { opacity: 0; }
    .cpm-bar button { all: unset; cursor: pointer; min-width: 30px; height: 28px; text-align: center; border-radius: 999px; padding: 0 6px; }
    .cpm-bar button:hover { background: rgba(255, 255, 255, .15); }
    .cpm-bar span { min-width: 48px; text-align: center; }
    @page { size: ${W}px ${H}px; margin: 0; }
    @media print {
      html, body { height: auto; overflow: visible; background: none; }
      body > section { display: block !important; position: relative !important; left: 0 !important; top: 0 !important; transform: none !important; break-after: page; page-break-after: always; }
      body > section:last-of-type { break-after: auto; page-break-after: auto; }
      .cpm-bar { display: none !important; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }`;
  document.head.append(style);

  let slides = [];
  let index = 0;
  let bar = null;
  let counter = null;
  let hideTimer = 0;

  const post = (msg) => window.parent !== window && window.parent.postMessage({ cpm: 1, ...msg }, '*');

  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    for (const el of slides) el.style.transform = `translate(-50%, -50%) scale(${s})`;
  }

  function go(i, fromHash = false) {
    if (!slides.length) return;
    index = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((el, n) => el.classList.toggle('cpm-on', n === index));
    counter.textContent = `${index + 1}/${slides.length}`;
    if (!fromHash) history.replaceState(null, '', `#${index + 1}`);
    post({ type: 'slide', index: index + 1, count: slides.length });
  }

  function showBar() {
    bar.classList.remove('cpm-hide');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.add('cpm-hide'), 2500);
  }

  function button(text, title, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function init() {
    slides = [...document.querySelectorAll('body > section')];
    if (!slides.length) return;
    counter = document.createElement('span');
    bar = document.createElement('div');
    bar.className = 'cpm-bar';
    bar.setAttribute('data-cpm', '');
    bar.append(button('‹', 'Slide trước', () => go(index - 1)), counter, button('›', 'Slide sau', () => go(index + 1)), button('⛶', 'Toàn màn hình (F)', fullscreen));
    document.body.append(bar);
    fit();
    go((Number(location.hash.slice(1)) || 1) - 1, true);
    showBar();

    addEventListener('resize', fit);
    addEventListener('hashchange', () => go((Number(location.hash.slice(1)) || 1) - 1, true));
    addEventListener('mousemove', showBar);
    addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, [contenteditable]')) return;
      const k = e.key;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(k)) go(index + 1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) go(index - 1);
      else if (k === 'Home') go(0);
      else if (k === 'End') go(slides.length - 1);
      else if (k === 'f' || k === 'F') fullscreen();
      else return;
      e.preventDefault();
    });
    let touch = null;
    addEventListener('touchstart', (e) => {
      touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      showBar();
    }, { passive: true });
    addEventListener('touchend', (e) => {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(t.clientY - touch.y)) go(index + (dx < 0 ? 1 : -1));
      touch = null;
    });
    window.cpmSlides = { go: (n) => go(n - 1), count: slides.length };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
