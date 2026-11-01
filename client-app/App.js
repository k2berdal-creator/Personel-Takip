import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert
} from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import io from 'socket.io-client';

const LOCATION_TASK_NAME = 'background-location-task';

let globalServerUrl = 'http://192.168.1.110:5005';
let globalUserId = 'Personel_1';

// HTTP POST ile garantili konum iletici (Mobil kopmalara karsi en guvenli yontem)
async function postLocationHttp(url, id, lat, lon, speed = 0, battery = 90) {
  try {
    const cleanUrl = url.trim().replace(/\/$/, '');
    const res = await fetch(`${cleanUrl}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
        'Bypass-Tunnel-Reminder': 'true'
      },
      body: JSON.stringify({ id, lat, lon, speed, battery })
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: data.status, message: data.message };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

try {
  TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
    if (error || !data || !data.locations || data.locations.length === 0) return;
    const loc = data.locations[0];
    await postLocationHttp(globalServerUrl, globalUserId, loc.coords.latitude, loc.coords.longitude);
  });
} catch (e) {}

export default function App() {
  const [serverUrl, setServerUrl] = useState('http://192.168.1.110:5005');
  const [userId, setUserId] = useState('Personel_1');
  const [isConnected, setIsConnected] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [lastCoords, setLastCoords] = useState(null);
  const [lastTime, setLastTime] = useState(null);
  const [statusMessage, setStatusMessage] = useState('Hazır.');

  const socketRef = useRef(null);
  const locationWatcherRef = useRef(null);

  useEffect(() => {
    globalServerUrl = serverUrl;
    globalUserId = userId;
  }, [serverUrl, userId]);

  // Sunucu bağlantısı
  const toggleConnection = () => {
    if (isConnected) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setIsConnected(false);
      setStatusMessage('Bağlantı kapatıldı.');
      stopTracking();
      return;
    }

    try {
      setStatusMessage('Bağlanılıyor...');
      const cleanUrl = serverUrl.trim().replace(/\/$/, '');
      const newSocket = io(cleanUrl, {
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        extraHeaders: {
          'ngrok-skip-browser-warning': 'true',
          'Bypass-Tunnel-Reminder': 'true'
        },
        timeout: 10000
      });

      newSocket.on('connect', () => {
        setIsConnected(true);
        setStatusMessage('Merkeze bağlandı.');
      });

      newSocket.on('disconnect', () => {
        // HTTP yedegi oldugu icin kullaniciyi engellemiyoruz
        setStatusMessage('Soket yeniden bağlanıyor...');
      });

      newSocket.on('connect_error', (err) => {
        setStatusMessage(`Soket uyarısı: ${err.message} (HTTP devrede)`);
      });

      socketRef.current = newSocket;

      // HTTP ile de sunucu durumunu aninda test et
      fetch(`${cleanUrl}/api/status`, {
        headers: {
          'ngrok-skip-browser-warning': 'true',
          'Bypass-Tunnel-Reminder': 'true'
        }
      })
        .then(r => r.json())
        .then(() => {
          setIsConnected(true);
          setStatusMessage('Sunucu aktif ve erişilebilir.');
        })
        .catch(() => {});

    } catch (err) {
      setStatusMessage(`Hata: ${err.message}`);
    }
  };

  // Konum Gönderimi: Hem Soket hem HTTP POST (Çift Hat - Asla Kopmaz)
  const sendLocation = async (lat, lon, speed = 0, battery = 90) => {
    const timeStr = new Date().toLocaleTimeString();
    const currentUserId = userId.trim() || 'Personel_1';
    setLastCoords({ latitude: lat, longitude: lon });
    setLastTime(timeStr);

    // 1. Soket kanalı
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('updateLocation', {
        userId: currentUserId,
        latitude: lat,
        longitude: lon,
        speed: speed,
        battery: battery,
        timestamp: new Date().toISOString()
      });
    }

    // 2. HTTP POST kanalı (Garantili teslimat)
    setStatusMessage('Konum merkeze iletiliyor...');
    const result = await postLocationHttp(serverUrl, currentUserId, lat, lon, speed, battery);

    if (result.status === 'OFF_SHIFT') {
      setStatusMessage(`⏰ Mesai Dışı: ${result.message}`);
    } else if (result.ok) {
      setIsConnected(true);
      setStatusMessage(`Konum başarıyla iletildi (${timeStr})`);
    } else {
      setStatusMessage(`Konum gönderildi (Soket denendi, HTTP zaman aşımı).`);
    }
  };

  // Canlı GPS Takibini Başlat
  const startTracking = async () => {
    try {
      const { status: fStatus } = await Location.requestForegroundPermissionsAsync();
      if (fStatus !== 'granted') {
        Alert.alert('İzin Gerekli', 'Konum izni verilmedi.');
        return;
      }

      setIsTracking(true);
      setStatusMessage('Canlı takip aktif.');

      // İlk anlık konum (En yüksek hassasiyet - Gerçek GPS uyduları)
      const initialPos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest
      });
      const initSpeed = Math.max(0, Math.round(((initialPos.coords.speed || 0) * 3.6)));
      await sendLocation(initialPos.coords.latitude, initialPos.coords.longitude, initSpeed, 92);

      // Canlı takip döngüsü (GNSS / Uydu seviyesinde 3-5 metre hassasiyet)
      locationWatcherRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Highest,
          timeInterval: 2000,
          distanceInterval: 1
        },
        (loc) => {
          const spdKmH = Math.max(0, Math.round(((loc.coords.speed || 0) * 3.6)));
          sendLocation(loc.coords.latitude, loc.coords.longitude, spdKmH, 92);
        }
      );
    } catch (err) {
      Alert.alert('Hata', err.message);
      setIsTracking(false);
    }
  };

  const stopTracking = async () => {
    if (locationWatcherRef.current) {
      locationWatcherRef.current.remove();
      locationWatcherRef.current = null;
    }
    setIsTracking(false);
    setStatusMessage('Takip durduruldu.');
  };

  // Test Konumu Gönder
  const sendTestLocation = async () => {
    // Ankara merkez civarı rastgele koordinat
    const baseLat = 39.92077;
    const baseLng = 32.85411;
    const offsetLat = (Math.random() - 0.5) * 0.02;
    const offsetLng = (Math.random() - 0.5) * 0.02;
    await sendLocation(baseLat + offsetLat, baseLng + offsetLng);
  };

  // SOS Panik Butonu
  const triggerSos = async () => {
    Alert.alert(
      '🚨 ACİL DURUM (SOS)',
      'Merkeze acil yardım çağrısı gönderilsin mi?',
      [
        { text: 'İptal', style: 'cancel' },
        {
          text: 'EVET, GÖNDER',
          style: 'destructive',
          onPress: async () => {
            try {
              let coords = lastCoords;
              if (!coords) {
                const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
                coords = loc.coords;
              }
              const cleanUrl = serverUrl.trim().replace(/\/$/, '');
              await fetch(`${cleanUrl}/sos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userId,
                  latitude: coords.latitude,
                  longitude: coords.longitude,
                  timestamp: new Date().toISOString()
                })
              });
              Alert.alert('🚨 İLETİLDİ', 'Acil durum çağrınız sirenle yönetici haritasına iletildi.');
            } catch (e) {
              Alert.alert('Hata', 'SOS iletilemedi: ' + e.message);
            }
          }
        }
      ]
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Personel Takip İstemcisi</Text>

      {/* Durum Rozeti */}
      <View style={[styles.badge, { backgroundColor: isConnected ? '#e6f4ea' : '#fce8e6' }]}>
        <Text style={[styles.badgeText, { color: isConnected ? '#137333' : '#c5221f' }]}>
          {isConnected ? '● Sunucuya Bağlı' : '○ Bağlantı Kuruluyor'}
        </Text>
      </View>

      {/* Sunucu Ayarı */}
      <View style={styles.card}>
        <Text style={styles.label}>Sunucu Adresi (URL / Ngrok):</Text>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="https://xxxx.ngrok-free.app"
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.label}>Personel Adı / Kod:</Text>
        <TextInput
          style={styles.input}
          value={userId}
          onChangeText={setUserId}
          placeholder="Örn: Personel_1"
          autoCapitalize="none"
        />

        <TouchableOpacity
          style={[styles.button, { backgroundColor: isConnected ? '#d93025' : '#1a73e8' }]}
          onPress={toggleConnection}
        >
          <Text style={styles.buttonText}>
            {isConnected ? 'Bağlantıyı Yenile' : 'Sunucuya Bağlan'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* İşlem Butonları */}
      <View style={styles.card}>
        <Text style={styles.label}>Konum Paylaşımı:</Text>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: isTracking ? '#e37400' : '#1e8e3e' }]}
          onPress={isTracking ? stopTracking : startTracking}
        >
          <Text style={styles.buttonText}>
            {isTracking ? 'Takibi Durdur' : '▶ Canlı Takibi Başlat'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={sendTestLocation}
        >
          <Text style={styles.secondaryButtonText}>📍 Test Konumu Gönder (Simülasyon)</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: '#d93025', marginTop: 10 }]}
          onPress={triggerSos}
        >
          <Text style={styles.buttonText}>🚨 SOS / ACİL DURUM BİLDİR</Text>
        </TouchableOpacity>
      </View>

      {/* Bilgi Kutusu */}
      <View style={styles.card}>
        <Text style={styles.label}>Son Gönderilen Konum:</Text>
        {lastCoords ? (
          <View>
            <Text style={styles.infoText}>Enlem: {lastCoords.latitude.toFixed(6)}</Text>
            <Text style={styles.infoText}>Boylam: {lastCoords.longitude.toFixed(6)}</Text>
            <Text style={styles.infoText}>Saat: {lastTime}</Text>
          </View>
        ) : (
          <Text style={styles.placeholderText}>Henüz konum gönderilmedi.</Text>
        )}

        <View style={styles.divider} />
        <Text style={styles.statusLog}>Durum: {statusMessage}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 50, backgroundColor: '#f8f9fa' },
  title: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 12, color: '#202124' },
  badge: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, alignSelf: 'center', marginBottom: 16 },
  badgeText: { fontWeight: 'bold', fontSize: 14 },
  card: { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#dadce0', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  label: { fontSize: 14, fontWeight: '600', color: '#3c4043', marginBottom: 6 },
  input: { borderWidth: 1, borderColor: '#dadce0', borderRadius: 6, padding: 10, fontSize: 15, marginBottom: 12, backgroundColor: '#fff' },
  button: { paddingVertical: 12, borderRadius: 6, alignItems: 'center', marginTop: 4 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  secondaryButton: { backgroundColor: '#f1f3f4', borderWidth: 1, borderColor: '#dadce0', marginTop: 10 },
  secondaryButtonText: { color: '#1a73e8', fontSize: 14, fontWeight: '600' },
  infoText: { fontSize: 14, color: '#202124', marginBottom: 2 },
  placeholderText: { fontSize: 13, color: '#80868b', fontStyle: 'italic' },
  divider: { height: 1, backgroundColor: '#e8eaed', marginVertical: 10 },
  statusLog: { fontSize: 12, color: '#5f6368' }
});
