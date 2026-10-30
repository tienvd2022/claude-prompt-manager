import { Platform, ToastAndroid } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

// url là link tải dùng một lần do web xin từ server (POST .../download-ticket), không cần cookie đăng nhập.
export async function downloadFile(
  url: string,
  name: string,
  onProgress: (ratio: number) => void,
): Promise<void> {
  const safeName = name.replace(/[/\\]/g, '_') || 'download';
  const dirs = ReactNativeBlobUtil.fs.dirs;
  // iOS: lưu trong Documents, hiện ở app Files ("Trên iPhone" > app). Android: tải vào cache rồi chép sang Download.
  const target = Platform.OS === 'ios' ? `${dirs.DocumentDir}/${safeName}` : `${dirs.CacheDir}/${Date.now()}-${safeName}`;

  const res = await ReactNativeBlobUtil.config({ path: target, overwrite: true })
    .fetch('GET', url)
    .progress({ interval: 200 }, (received, total) => {
      if (Number(total) > 0) onProgress(Number(received) / Number(total));
    });
  const status = res.info().status;
  if (status !== 200) {
    await ReactNativeBlobUtil.fs.unlink(target).catch(() => {});
    throw new Error(status === 404 ? 'Link tải đã hết hạn, thử lại' : `Tải thất bại (HTTP ${status})`);
  }

  if (Platform.OS === 'ios') {
    ReactNativeBlobUtil.ios.presentOptionsMenu(target);
    return;
  }
  try {
    await ReactNativeBlobUtil.MediaCollection.copyToMediaStore(
      { name: safeName, parentFolder: '', mimeType: contentType(res.info().headers) },
      'Download',
      target,
    );
    ToastAndroid.show(`Đã lưu vào Download/${safeName}`, ToastAndroid.LONG);
  } finally {
    await ReactNativeBlobUtil.fs.unlink(target).catch(() => {});
  }
}

function contentType(headers: Record<string, string>): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  return (key && headers[key].split(';')[0].trim()) || 'application/octet-stream';
}
