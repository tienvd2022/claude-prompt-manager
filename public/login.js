'use strict';

const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    if (res.ok) {
      location.href = '/';
      return;
    }
    const data = await res.json().catch(() => ({}));
    errorEl.textContent = data.error || `Lỗi ${res.status}`;
    form.password.value = '';
    form.password.focus();
  } catch {
    errorEl.textContent = 'Không kết nối được server';
  } finally {
    button.disabled = false;
  }
});

// Trong app mobile (mobile/): quay về màn chọn server.
const switchServer = document.getElementById('login-switch-server');
if (window.ReactNativeWebView && window.CPM_APP) {
  switchServer.hidden = false;
  switchServer.addEventListener('click', () => window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'switchServer' })));
}
