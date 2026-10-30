import { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import ServerScreen from './src/ServerScreen';
import { getLast, setLast } from './src/servers';
import { colors } from './src/theme';
import WebScreen from './src/WebScreen';

// Mở lại server dùng lần trước; không có thì vào màn chọn server.
export default function App() {
  const [ready, setReady] = useState(false);
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    getLast()
      .then(setServer)
      .finally(() => setReady(true));
  }, []);

  function open(url: string | null) {
    setServer(url);
    setLast(url);
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
        {!ready ? (
          <View style={styles.root} />
        ) : server ? (
          <WebScreen key={server} url={server} onSwitchServer={() => open(null)} />
        ) : (
          <ServerScreen onConnect={open} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
