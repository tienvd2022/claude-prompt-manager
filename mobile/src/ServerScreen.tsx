import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { hostOf, loadServers, normalizeUrl, probe, saveServers, Server } from './servers';
import { colors } from './theme';

type Props = { onConnect: (url: string) => void };

// Màn chọn server: nhập địa chỉ bản web (vd https://prompt.domain.vn), app kiểm tra rồi mở bản web trong app.
// Bấm ✎ (hoặc nhấn giữ) một server đã lưu để sửa tên/địa chỉ trong cùng ô nhập.
export default function ServerScreen({ onConnect }: Props) {
  const [servers, setServers] = useState<Server[]>([]);
  const [input, setInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [editing, setEditing] = useState<Server | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadServers().then(setServers);
  }, []);

  // Chuẩn hóa địa chỉ và kiểm tra server; lỗi thì hiện ra và trả về null.
  async function check(raw: string): Promise<string | null> {
    setError('');
    let url: string;
    try {
      url = normalizeUrl(raw);
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
    setBusy(true);
    try {
      await probe(url);
      return url;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    const url = await check(input);
    if (!url) return;
    // Để trống tên thì giữ tên cũ (nếu server đã lưu), không có thì lấy tên miền.
    const name = nameInput.trim() || servers.find((s) => s.url === url)?.name || hostOf(url);
    const next = [{ url, name }, ...servers.filter((s) => s.url !== url)];
    setServers(next);
    await saveServers(next);
    setInput('');
    setNameInput('');
    onConnect(url);
  }

  function startEdit(server: Server) {
    setEditing(server);
    setInput(server.url);
    setNameInput(server.name);
    setError('');
  }

  function cancelEdit() {
    setEditing(null);
    setInput('');
    setNameInput('');
    setError('');
  }

  async function saveEdit() {
    if (!editing) return;
    // Chỉ kiểm tra lại server khi đổi địa chỉ.
    let url = editing.url;
    if (input.trim() !== editing.url) {
      const checked = await check(input);
      if (!checked) return;
      url = checked;
    }
    const name = nameInput.trim() || hostOf(url);
    const next = servers
      .filter((s) => s.url === editing.url || s.url !== url)
      .map((s) => (s.url === editing.url ? { url, name } : s));
    setServers(next);
    await saveServers(next);
    cancelEdit();
  }

  const submit = () => (editing ? saveEdit() : connect());

  function remove(server: Server) {
    Alert.alert('Xóa server', `Xóa ${server.name} khỏi danh sách?`, [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa',
        style: 'destructive',
        onPress: async () => {
          const next = servers.filter((s) => s.url !== server.url);
          setServers(next);
          await saveServers(next);
          if (editing?.url === server.url) cancelEdit();
        },
      },
    ]);
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <Text style={styles.title}>{editing ? 'Sửa server' : 'Claude Prompt Manager'}</Text>
        <Text style={styles.muted}>{editing ? editing.url : 'Nhập địa chỉ server (bản web) để kết nối'}</Text>
        <TextInput
          style={styles.input}
          value={nameInput}
          onChangeText={setNameInput}
          placeholder="Tên server (không bắt buộc)"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          returnKeyType="next"
          editable={!busy}
          maxLength={60}
        />
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="https://prompt.domain.vn"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          editable={!busy}
          onSubmitEditing={submit}
        />
        <View style={styles.actions}>
          {editing && (
            <Pressable style={[styles.button, styles.secondary, busy && styles.disabled]} disabled={busy} onPress={cancelEdit}>
              <Text style={styles.secondaryText}>Hủy</Text>
            </Pressable>
          )}
          <Pressable style={[styles.button, styles.grow, busy && styles.disabled]} disabled={busy} onPress={submit}>
            {busy ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.buttonText}>{editing ? 'Lưu' : 'Kết nối'}</Text>}
          </Pressable>
        </View>
        {!!error && <Text style={styles.error}>{error}</Text>}
      </View>

      {servers.length > 0 && (
        <View style={styles.listWrap}>
          <Text style={styles.section}>Server đã lưu</Text>
          <FlatList
            data={servers}
            keyExtractor={(s) => s.url}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed, editing?.url === item.url && styles.rowEditing]}
                disabled={busy}
                onPress={() => onConnect(item.url)}
                onLongPress={() => startEdit(item)}
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowName}>{item.name}</Text>
                  <Text style={styles.muted}>{item.url}</Text>
                </View>
                <Pressable hitSlop={10} onPress={() => startEdit(item)}>
                  <Text style={styles.remove}>✎</Text>
                </Pressable>
                <Pressable hitSlop={10} onPress={() => remove(item)}>
                  <Text style={styles.remove}>✕</Text>
                </Pressable>
              </Pressable>
            )}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, justifyContent: 'center', backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
    gap: 12,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 13 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  button: { backgroundColor: colors.accent, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: colors.accentText, fontWeight: '700', fontSize: 15 },
  actions: { flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
  secondary: { backgroundColor: colors.panel2, paddingHorizontal: 20 },
  secondaryText: { color: colors.text, fontWeight: '600', fontSize: 15 },
  disabled: { opacity: 0.6 },
  error: { color: colors.danger, fontSize: 13 },
  listWrap: { marginTop: 20, maxHeight: '45%' },
  section: { color: colors.muted, fontSize: 12, textTransform: 'uppercase', marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  rowPressed: { backgroundColor: colors.panel2 },
  rowEditing: { borderColor: colors.accent },
  rowText: { flex: 1, gap: 2 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  remove: { color: colors.muted, fontSize: 16, paddingHorizontal: 6 },
});
