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
export default function ServerScreen({ onConnect }: Props) {
  const [servers, setServers] = useState<Server[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadServers().then(setServers);
  }, []);

  async function connect(raw: string) {
    setError('');
    let url: string;
    try {
      url = normalizeUrl(raw);
    } catch (err) {
      return setError((err as Error).message);
    }
    setBusy(true);
    try {
      await probe(url);
    } catch (err) {
      setBusy(false);
      return setError((err as Error).message);
    }
    setBusy(false);
    const next = [{ url, name: hostOf(url) }, ...servers.filter((s) => s.url !== url)];
    setServers(next);
    await saveServers(next);
    setInput('');
    onConnect(url);
  }

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
        },
      },
    ]);
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <Text style={styles.title}>Claude Prompt Manager</Text>
        <Text style={styles.muted}>Nhập địa chỉ server (bản web) để kết nối</Text>
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
          onSubmitEditing={() => connect(input)}
        />
        <Pressable style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => connect(input)}>
          {busy ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.buttonText}>Kết nối</Text>}
        </Pressable>
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
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                disabled={busy}
                onPress={() => onConnect(item.url)}
                onLongPress={() => remove(item)}
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowName}>{item.name}</Text>
                  <Text style={styles.muted}>{item.url}</Text>
                </View>
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
  rowText: { flex: 1, gap: 2 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  remove: { color: colors.muted, fontSize: 16, paddingHorizontal: 6 },
});
