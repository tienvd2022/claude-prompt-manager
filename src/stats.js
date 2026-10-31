'use strict';

// Số liệu tài nguyên cho thanh trạng thái: RAM/disk của cả server, phần của user đang chạy app,
// RAM của chính app (node + tiến trình con như Chromium) và của các phiên Claude (cây tiến trình tmux).
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { PROJECTS_DIR } = require('./projects');
const tmux = require('./tmux');

const UID = process.getuid ? process.getuid() : null;
const USER = os.userInfo().username;
const HOME = os.homedir();

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// Linux: MemAvailable mới phản ánh đúng RAM còn dùng được (freemem tính cả cache là đã dùng).
function memory() {
  const total = os.totalmem();
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
    if (m) return { total, used: total - Number(m[1]) * 1024 };
  } catch {
    // không phải Linux
  }
  return { total, used: total - os.freemem() };
}

async function disk() {
  try {
    const s = await fs.promises.statfs(PROJECTS_DIR);
    const total = s.blocks * s.bsize;
    // used tính như df: tổng trừ phần trống (kể cả phần dành riêng cho root).
    return { total, used: total - s.bfree * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

// RSS cộng dồn theo cây tiến trình. RSS đếm trùng phần bộ nhớ dùng chung nên chỉ là số gần đúng.
async function processes() {
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,uid=,rss=']);
  const procs = [];
  for (const line of out.split('\n')) {
    const [pid, ppid, uid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid) procs.push({ pid, ppid, uid, rss: rss * 1024 });
  }
  return procs;
}

function treeRss(procs, rootPid) {
  if (!rootPid) return 0;
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  let sum = 0;
  const stack = procs.filter((p) => p.pid === rootPid);
  while (stack.length) {
    const p = stack.pop();
    sum += p.rss;
    stack.push(...(kids.get(p.pid) || []));
  }
  return sum;
}

// Dung lượng thư mục home của user: du chạy lâu nên chạy nền, nhẹ nhàng (nice), lưu kết quả 10 phút.
const DU_TTL = 10 * 60 * 1000;
let homeDisk = { bytes: null, at: 0, running: false };
function refreshHomeDisk() {
  if (homeDisk.running || Date.now() - homeDisk.at < DU_TTL) return;
  homeDisk.running = true;
  const child = spawn('nice', ['-n', '19', 'du', '-sk', HOME], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = () => {
    const kb = Number(out.trim().split(/\s+/)[0]);
    homeDisk = { bytes: Number.isFinite(kb) && out ? kb * 1024 : homeDisk.bytes, at: Date.now(), running: false };
  };
  child.on('close', done); // du có thể báo lỗi quyền ở vài thư mục nhưng vẫn in tổng
  child.on('error', done);
}

let cache = null;
let cacheAt = 0;
async function get() {
  if (cache && Date.now() - cacheAt < 2000) return cache;
  refreshHomeDisk();
  const [procs, tmuxPid, d] = await Promise.all([processes().catch(() => []), tmux.serverPid(), disk()]);
  const userRam = procs.filter((p) => p.uid === UID).reduce((n, p) => n + p.rss, 0);
  cache = {
    user: USER,
    ram: { ...memory(), user: userRam || null, app: treeRss(procs, process.pid) || process.memoryUsage().rss, claude: treeRss(procs, tmuxPid) },
    disk: d && { ...d, user: homeDisk.bytes, home: HOME },
  };
  cacheAt = Date.now();
  return cache;
}

module.exports = { get };
