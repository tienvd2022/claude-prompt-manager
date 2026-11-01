import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

// Bản Mac (Mac Catalyst) không có native module AsyncStorage (xem ios/Podfile): lưu vào một file JSON.
type KV = {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
};

function fileStore(): KV {
  // Không sandbox nên LibraryDir là ~/Library: để trong Application Support, không bày ra ~/Documents.
  const dir = `${ReactNativeBlobUtil.fs.dirs.LibraryDir}/Application Support/vn.nhanhnhau.cpm`;
  const path = `${dir}/settings.json`;
  let cache: Record<string, string> | null = null;
  const read = async () => {
    if (cache) return cache;
    try {
      cache = (await ReactNativeBlobUtil.fs.exists(path)) ? JSON.parse(await ReactNativeBlobUtil.fs.readFile(path, 'utf8')) : {};
    } catch {
      cache = {};
    }
    return cache!;
  };
  const write = async (data: Record<string, string>) => {
    if (!(await ReactNativeBlobUtil.fs.isDir(dir))) await ReactNativeBlobUtil.fs.mkdir(dir).catch(() => {});
    await ReactNativeBlobUtil.fs.writeFile(path, JSON.stringify(data), 'utf8');
  };
  return {
    getItem: async (k) => (await read())[k] ?? null,
    setItem: async (k, v) => {
      const data = { ...(await read()), [k]: v };
      await write(data);
      cache = data;
    },
    removeItem: async (k) => {
      const data = { ...(await read()) };
      delete data[k];
      await write(data);
      cache = data;
    },
  };
}

const AsyncStorage: KV = Platform.OS === 'ios' && Platform.isMacCatalyst
  ? fileStore()
  : require('@react-native-async-storage/async-storage').default;

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
