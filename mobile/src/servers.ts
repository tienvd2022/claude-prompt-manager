import AsyncStorage from '@react-native-async-storage/async-storage';

export type Server = { url: string; name: string };

const SERVERS_KEY = 'servers';
const LAST_KEY = 'lastServer';

// "prompt.domain.vn/abc" -> "https://prompt.domain.vn". Chỉ giữ origin, bỏ đường dẫn phía sau.
export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('Nhập địa chỉ server');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const m = s.match(/^(https?):\/\/([^/?#\s]+)/i);
  if (!m) throw new Error('Địa chỉ không hợp lệ');
  const scheme = m[1].toLowerCase();
  // Bỏ cổng mặc định cho giống location.origin của trang (so khớp link cùng server trong WebView).
  const host = m[2].toLowerCase().replace(scheme === 'https' ? /:443$/ : /:80$/, '');
  return `${scheme}://${host}`;
}

export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

// Kiểm tra đúng là server Claude Prompt Manager trước khi lưu.
export async function probe(url: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let res: Response;
  try {
    res = await fetch(`${url}/login`, { signal: ctrl.signal, headers: { Accept: 'text/html' } });
  } catch {
    throw new Error('Không kết nối được server. Kiểm tra địa chỉ và mạng.');
  } finally {
    clearTimeout(timer);
  }
  const html = await res.text().catch(() => '');
  if (!res.ok || !html.includes('<title>Claude Prompt Manager</title>')) {
    throw new Error(`Server không phải Claude Prompt Manager (HTTP ${res.status})`);
  }
}

export async function loadServers(): Promise<Server[]> {
  try {
    const list = JSON.parse((await AsyncStorage.getItem(SERVERS_KEY)) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveServers(list: Server[]): Promise<void> {
  await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(list));
}

export async function getLast(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_KEY);
}

export async function setLast(url: string | null): Promise<void> {
  if (url) await AsyncStorage.setItem(LAST_KEY, url);
  else await AsyncStorage.removeItem(LAST_KEY);
}
