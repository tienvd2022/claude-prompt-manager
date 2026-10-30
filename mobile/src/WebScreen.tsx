import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView as WebViewBase, WebViewMessageEvent } from 'react-native-webview';
import { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { downloadFile } from './download';
import { hostOf } from './servers';
import { colors } from './theme';

type Props = { url: string; onSwitchServer: () => void };

// Typing của react-native-webview: WebViewProps & undefined thành never với React 19, nên chỉ định P = {}.
const WebView = WebViewBase as typeof WebViewBase<{}>;
type WebView = WebViewBase<{}>;

const APP_VERSION = '1';

// Bản web đọc window.CPM_APP để biết đang chạy trong app (hiện nút đổi server, tải file qua native).
const INJECT = `window.CPM_APP = { platform: ${JSON.stringify(Platform.OS)}, version: ${APP_VERSION} }; true;`;

// Tin nhắn web gửi sang: { type: 'download', url, name } | { type: 'switchServer' }.
type Message = { type: 'download'; url: string; name: string } | { type: 'switchServer' };

export default function WebScreen({ url, onSwitchServer }: Props) {
  const web = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const downloading = useRef(false);
  // SafeAreaView bên ngoài đã chừa thanh điều hướng, bàn phím phủ lên cả phần đó.
  const keyboard = Math.max(0, useAndroidKeyboardHeight() - useSafeAreaInsets().bottom);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current) {
        web.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  function sameOrigin(target: string) {
    return target === url || target.startsWith(`${url}/`) || target.startsWith(`${url}?`) || target.startsWith(`${url}#`);
  }

  function onShouldStart(req: ShouldStartLoadRequest) {
    if (sameOrigin(req.url) || /^(about|data|blob):/.test(req.url)) return true;
    // Link ra ngoài (GitHub…) thì mở bằng trình duyệt của máy.
    if (req.isTopFrame !== false) Linking.openURL(req.url).catch(() => {});
    return false;
  }

  async function onMessage(e: WebViewMessageEvent) {
    let msg: Message;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'switchServer') return onSwitchServer();
    if (msg.type === 'download' && typeof msg.url === 'string' && sameOrigin(msg.url) && !downloading.current) {
      downloading.current = true;
      setProgress(0);
      try {
        await downloadFile(msg.url, String(msg.name || ''), setProgress);
      } catch (err) {
        Alert.alert('Không tải được', (err as Error).message);
      } finally {
        downloading.current = false;
        setProgress(null);
      }
    }
  }

  function reload() {
    setError('');
    web.current?.reload();
  }

  return (
    <View style={[styles.root, { paddingBottom: keyboard }]}>
      <WebView
        ref={web}
        source={{ uri: `${url}/` }}
        style={styles.web}
        containerStyle={styles.web}
        injectedJavaScriptBeforeContentLoaded={INJECT}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStart}
        onNavigationStateChange={(s) => { canGoBack.current = s.canGoBack; }}
        onLoadStart={() => setError('')}
        onError={(e) => setError(e.nativeEvent.description || 'Không tải được trang')}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500) setError(`Server lỗi (HTTP ${e.nativeEvent.statusCode})`);
        }}
        onContentProcessDidTerminate={() => web.current?.reload()}
        onRenderProcessGone={() => web.current?.reload()}
        startInLoadingState
        renderLoading={() => (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <ActivityIndicator color={colors.accent} size="large" />
          </View>
        )}
        sharedCookiesEnabled
        domStorageEnabled
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        keyboardDisplayRequiresUserAction={false}
        allowsBackForwardNavigationGestures={false}
        allowsInlineMediaPlayback
        mediaCapturePermissionGrantType="grant"
        textZoom={100}
        overScrollMode="never"
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        webviewDebuggingEnabled={__DEV__}
        applicationNameForUserAgent={`CPMApp/${APP_VERSION}`}
      />

      {!!error && (
        <View style={[StyleSheet.absoluteFill, styles.center, styles.overlay]}>
          <Text style={styles.errorTitle}>Không kết nối được {hostOf(url)}</Text>
          <Text style={styles.muted}>{error}</Text>
          <View style={styles.actions}>
            <Pressable style={styles.primary} onPress={reload}>
              <Text style={styles.primaryText}>Thử lại</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={onSwitchServer}>
              <Text style={styles.secondaryText}>Đổi server</Text>
            </Pressable>
          </View>
        </View>
      )}

      {progress !== null && (
        <View style={styles.toast} pointerEvents="none">
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.toastText}>Đang tải… {progress > 0 ? `${Math.round(progress * 100)}%` : ''}</Text>
        </View>
      )}
    </View>
  );
}

// Android (edge-to-edge) không tự co WebView khi bàn phím bật, nên tự chừa chỗ cho bàn phím.
// iOS: WKWebView tự xử lý, bản web co lại theo visualViewport.
function useAndroidKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  overlay: { padding: 24, gap: 10 },
  errorTitle: { color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  muted: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 12 },
  primary: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 18 },
  primaryText: { color: colors.accentText, fontWeight: '700' },
  secondary: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 18 },
  secondaryText: { color: colors.text },
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  toastText: { color: colors.text },
});
