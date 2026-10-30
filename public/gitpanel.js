// Panel git của dự án: trạng thái, thay đổi, commit, lịch sử, fetch/pull/push.

import { $, el, api, projectUrl, timeAgo, toast, showText, followJob } from './common.js';

const infoEl = $('#git-info');
const changesEl = $('#git-changes');
const logEl = $('#git-log');
const jobEl = $('#git-job');
const repoEl = $('#git-repo');
const noRepoEl = $('#git-norepo');
const commitForm = $('#git-commit-form');

let project = null;
let running = false;

const XY_LABEL = { M: 'sửa', A: 'thêm', D: 'xóa', R: 'đổi tên', C: 'chép', U: 'xung đột', T: 'đổi loại' };

export function initGit() {
  $('#git-refresh').addEventListener('click', () => load());
  document.querySelectorAll('[data-git]').forEach((btn) => btn.addEventListener('click', () => runRemote(btn.dataset.git)));
  $('#git-init').addEventListener('click', async () => {
    try {
      await api('POST', projectUrl(project, '/git/init'));
      toast('Đã tạo repo git');
    } catch (err) {
      toast(err.message, 'error');
    }
    load();
  });
  commitForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = commitForm.message.value.trim();
    if (!message) return;
    try {
      const { output } = await api('POST', projectUrl(project, '/git/commit'), { message });
      commitForm.message.value = '';
      toast(output.split('\n')[0] || 'Đã commit');
    } catch (err) {
      toast(err.message, 'error');
    }
    load();
  });
}

export function setGitProject(name) {
  if (project === name) return;
  project = name;
  jobEl.hidden = true;
  infoEl.replaceChildren();
  changesEl.replaceChildren();
  logEl.replaceChildren();
}

export async function load() {
  if (!project) return;
  const current = project;
  let st;
  try {
    st = await api('GET', projectUrl(current, '/git/status'));
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (current !== project) return;
  repoEl.hidden = !st.repo;
  noRepoEl.hidden = st.repo;
  if (!st.repo) return;
  renderInfo(st);
  renderChanges(st);
  try {
    renderLog((await api('GET', projectUrl(current, '/git/log'))).commits);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderInfo(st) {
  const sync = st.upstream
    ? [st.ahead ? `↑${st.ahead} chưa push` : '', st.behind ? `↓${st.behind} chưa pull` : ''].filter(Boolean).join(' · ') || 'đã đồng bộ'
    : 'chưa có nhánh trên remote';
  infoEl.replaceChildren(
    el('div', {}, el('span', { class: 'branch', text: `⎇ ${st.branch || '?'}` }), ' ', el('span', { class: 'muted', text: sync })),
    el('div', { class: 'muted small ellipsis', title: st.remote || '', text: st.remote ? `origin: ${st.remote}` : 'Chưa có remote origin' }),
  );
}

function renderChanges(st) {
  $('#git-count').textContent = st.total || st.changes.length;
  changesEl.replaceChildren();
  commitForm.hidden = !st.changes.length;
  if (!st.changes.length) {
    changesEl.append(el('li', { class: 'muted pad', text: 'Không có thay đổi.' }));
    return;
  }
  for (const c of st.changes) {
    const code = c.untracked ? '?' : c.conflict ? 'U' : (c.xy[0] !== '.' ? c.xy[0] : c.xy[1]);
    const label = c.untracked ? 'mới' : XY_LABEL[code] || code;
    changesEl.append(el('li', {}, el('button', {
      class: 'change',
      title: 'Xem thay đổi',
      onclick: async () => {
        try {
          const qs = new URLSearchParams({ path: c.path });
          if (c.untracked) qs.set('untracked', '1');
          showText(c.path, (await api('GET', projectUrl(project, `/git/diff?${qs}`))).text || '(không có khác biệt nội dung)');
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
    el('span', { class: `badge s-${code}`, text: label }),
    el('span', { class: 'ellipsis', text: c.from ? `${c.from} → ${c.path}` : c.path }))));
  }
}

function renderLog(commits) {
  logEl.replaceChildren();
  if (!commits.length) {
    logEl.append(el('li', { class: 'muted pad', text: 'Chưa có commit nào.' }));
    return;
  }
  for (const c of commits) {
    logEl.append(el('li', {}, el('button', {
      class: 'commit',
      title: 'Xem commit',
      onclick: async () => {
        try {
          showText(`${c.short} ${c.subject}`, (await api('GET', projectUrl(project, `/git/show?hash=${c.hash}`))).text);
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
    el('span', { class: 'commit-subject ellipsis', text: c.subject }),
    el('span', { class: 'muted small ellipsis', text: `${c.short} · ${c.author} · ${timeAgo(c.time)}${c.refs ? ` · ${c.refs}` : ''}` }))));
  }
}

async function runRemote(op) {
  if (running || !project) return;
  running = true;
  document.querySelectorAll('[data-git]').forEach((b) => { b.disabled = true; });
  try {
    const { job } = await api('POST', projectUrl(project, `/git/${op}`));
    const done = await followJob(job, jobEl);
    toast(done.status === 'ok' ? `git ${op} xong` : `git ${op} lỗi, xem chi tiết bên dưới`, done.status === 'ok' ? '' : 'error');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    running = false;
    document.querySelectorAll('[data-git]').forEach((b) => { b.disabled = false; });
    load();
  }
}
