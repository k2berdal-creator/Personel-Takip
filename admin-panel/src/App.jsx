import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMap } from 'react-leaflet';
import io from 'socket.io-client';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
  iconUrl: icon,
  shadowUrl: iconShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34]
});
L.Marker.prototype.options.icon = DefaultIcon;

const defaultBackend =
  typeof window !== 'undefined'
    ? (window.location.port === '5173' || window.location.port === '3000'
        ? `${window.location.protocol}//${window.location.hostname}:5005`
        : window.location.origin)
    : 'http://localhost:5005';
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || defaultBackend;
const socket = io(BACKEND_URL, {
  autoConnect: true,
  transports: ['websocket', 'polling'],
  extraHeaders: {
    'ngrok-skip-browser-warning': 'true',
    'Bypass-Tunnel-Reminder': 'true'
  }
});

function MapController({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (center && center[0] && center[1]) {
      map.setView(center, zoom);
    }
  }, [center, zoom, map]);
  return null;
}

function isOnline(timestamp) {
  if (!timestamp) return false;
  const diffMinutes = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60);
  return diffMinutes < 3;
}

function getSpeedBadge(speed) {
  const s = Math.round(speed || 0);
  if (s === 0) return { label: 'Duruyor / Mola', icon: '🔴', color: '#d93025' };
  if (s < 10) return { label: `${s} km/s (Yürüyor)`, icon: '🚶', color: '#188038' };
  return { label: `${s} km/s (Araçta)`, icon: '🚗', color: '#1a73e8' };
}

const ALL_DAYS = [
  { id: 1, name: 'Pzt' },
  { id: 2, name: 'Sal' },
  { id: 3, name: 'Çar' },
  { id: 4, name: 'Per' },
  { id: 5, name: 'Cum' },
  { id: 6, name: 'Cmt' },
  { id: 0, name: 'Paz' }
];

function App() {
  const [locations, setLocations] = useState({});
  const [selectedUser, setSelectedUser] = useState(null);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [showQr, setShowQr] = useState(false);

  // Rota & Geofence
  const [routePoints, setRoutePoints] = useState([]);
  const [showRoute, setShowRoute] = useState(true);
  const [userSummary, setUserSummary] = useState(null);
  const [geofences, setGeofences] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [showFenceModal, setShowFenceModal] = useState(false);
  const [newFenceName, setNewFenceName] = useState('Merkez Şantiye');
  const [newFenceRadius, setNewFenceRadius] = useState('500');

  // Mesai & Çalışma Saatleri State'leri
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [shiftSettings, setShiftSettings] = useState({
    activeDays: [1, 2, 3, 4, 5],
    startTime: '08:30',
    endTime: '18:00',
    blockOffShift: true
  });
  const [shiftStatus, setShiftStatus] = useState({ inShift: true });

  useEffect(() => {
    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);

    const handleInitialLocations = (data) => {
      if (!data) return;
      const formatted = {};
      Object.entries(data).forEach(([userId, loc]) => {
        formatted[userId] = {
          lat: loc.latitude,
          lng: loc.longitude,
          speed: loc.speed || 0,
          battery: loc.battery || 100,
          timestamp: loc.timestamp
        };
      });
      setLocations(formatted);
    };

    const handleLocationUpdate = (data) => {
      if (!data || !data.userId) return;
      setLocations((prev) => ({
        ...prev,
        [data.userId]: {
          lat: data.latitude,
          lng: data.longitude,
          speed: data.speed || 0,
          battery: data.battery || 100,
          timestamp: data.timestamp
        }
      }));

      if (selectedUser === data.userId) {
        setRoutePoints((prev) => [...prev, [data.latitude, data.longitude]]);
      }
    };

    const handleGeofenceAlert = (alertData) => {
      const msg = `⚠️ ${alertData.userId}, "${alertData.fenceName}" bölgesinden ${alertData.distance}m dışarı çıktı!`;
      setAlerts((prev) => [msg, ...prev.slice(0, 4)]);
    };

    const handleGeofencesUpdate = (fences) => {
      setGeofences(fences || []);
    };

    const handleShiftSettingsUpdate = (settings) => {
      setShiftSettings(settings);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('initialLocations', handleInitialLocations);
    socket.on('locationUpdate', handleLocationUpdate);
    socket.on('geofenceAlert', handleGeofenceAlert);
    socket.on('geofencesUpdate', handleGeofencesUpdate);
    socket.on('shiftSettingsUpdate', handleShiftSettingsUpdate);

    // REST ilk verileri al
    fetch(`${BACKEND_URL}/locations`).then((r) => r.json()).then(handleInitialLocations).catch(() => {});
    fetch(`${BACKEND_URL}/geofences`).then((r) => r.json()).then(setGeofences).catch(() => {});
    fetch(`${BACKEND_URL}/shift-settings`).then((r) => r.json()).then(setShiftSettings).catch(() => {});
    fetch(`${BACKEND_URL}/shift-status`).then((r) => r.json()).then(setShiftStatus).catch(() => {});

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('initialLocations', handleInitialLocations);
      socket.off('locationUpdate', handleLocationUpdate);
      socket.off('geofenceAlert', handleGeofenceAlert);
      socket.off('geofencesUpdate', handleGeofencesUpdate);
      socket.off('shiftSettingsUpdate', handleShiftSettingsUpdate);
    };
  }, [selectedUser]);

  const selectPersonnel = (userId) => {
    setSelectedUser(userId);
    fetch(`${BACKEND_URL}/history/${encodeURIComponent(userId)}`)
      .then((res) => res.json())
      .then((pts) => {
        setRoutePoints(pts.map((p) => [p.latitude, p.longitude]));
      })
      .catch(() => setRoutePoints([]));

    fetch(`${BACKEND_URL}/summary/${encodeURIComponent(userId)}`)
      .then((res) => res.json())
      .then((sum) => setUserSummary(sum))
      .catch(() => setUserSummary(null));
  };

  // Garantili Excel / CSV İndirme
  const handleDownloadCsv = async (userId) => {
    try {
      const res = await fetch(`${BACKEND_URL}/export-csv/${encodeURIComponent(userId)}`);
      if (!res.ok) {
        alert('Bu personel için henüz kaydedilmiş hareket verisi bulunamadı.');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${userId}_Gecmis_Rota_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      alert('İndirme hatası: ' + e.message);
    }
  };

  const handleAddGeofence = () => {
    const loc = selectedUser && locations[selectedUser] ? locations[selectedUser] : { lat: 41.042, lng: 28.69 };
    fetch(`${BACKEND_URL}/geofences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newFenceName,
        latitude: loc.lat,
        longitude: loc.lng,
        radius: Number(newFenceRadius)
      })
    })
      .then((r) => r.json())
      .then((updated) => {
        setGeofences(updated);
        setShowFenceModal(false);
      });
  };

  // Mesai Ayarlarını Kaydet
  const handleSaveShiftSettings = () => {
    fetch(`${BACKEND_URL}/shift-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(shiftSettings)
    })
      .then((r) => r.json())
      .then((updated) => {
        setShiftSettings(updated);
        setShowShiftModal(false);
        // Durumu da guncelle
        fetch(`${BACKEND_URL}/shift-status`).then((r) => r.json()).then(setShiftStatus);
      });
  };

  const toggleDay = (dayId) => {
    setShiftSettings((prev) => {
      const exists = prev.activeDays.includes(dayId);
      const nextDays = exists ? prev.activeDays.filter((d) => d !== dayId) : [...prev.activeDays, dayId];
      return { ...prev, activeDays: nextDays };
    });
  };

  const center =
    selectedUser && locations[selectedUser]
      ? [locations[selectedUser].lat, locations[selectedUser].lng]
      : Object.keys(locations).length > 0
      ? [Object.values(locations)[0].lat, Object.values(locations)[0].lng]
      : [41.042, 28.69];

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Sol Panel */}
      <div style={{ width: '380px', borderRight: '1px solid #e0e0e0', padding: '16px', overflowY: 'auto', backgroundColor: '#fafafa', display: 'flex', flexDirection: 'column' }}>
        
        {/* Üst Bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <h2 style={{ fontSize: '18px', margin: 0, color: '#202124' }}>Personel Takip</h2>
          <div style={{ display: 'flex', gap: '6px' }}>
            <span style={{
              fontSize: '11px',
              padding: '3px 8px',
              borderRadius: '12px',
              backgroundColor: shiftStatus.inShift ? '#e6f4ea' : '#feefe3',
              color: shiftStatus.inShift ? '#137333' : '#b06000',
              fontWeight: 'bold'
            }}>
              {shiftStatus.inShift ? '🟢 Mesai İçi' : '⏰ Mesai Dışı'}
            </span>
            <span style={{
              fontSize: '11px',
              padding: '3px 8px',
              borderRadius: '12px',
              backgroundColor: isConnected ? '#e6f4ea' : '#fce8e6',
              color: isConnected ? '#137333' : '#c5221f',
              fontWeight: 'bold'
            }}>
              {isConnected ? '● Bağlı' : '○ Bağlantı Yok'}
            </span>
          </div>
        </div>

        {/* Mesai Durum Bilgisi */}
        {!shiftStatus.inShift && (
          <div style={{ backgroundColor: '#feefe3', border: '1px solid #fedfc8', borderRadius: '6px', padding: '8px 10px', fontSize: '11px', color: '#b06000', marginBottom: '10px' }}>
            <strong>Bilgi:</strong> Şu an mesai dışı / izinli zaman dilimindeyiz. Personel takip kuralları devrede.
          </div>
        )}

        {/* Coğrafi Çit Alarmları */}
        {alerts.length > 0 && (
          <div style={{ backgroundColor: '#fce8e6', border: '1px solid #fad2cf', borderRadius: '6px', padding: '8px 12px', marginBottom: '12px', fontSize: '12px', color: '#c5221f' }}>
            <strong>Bölge İhlali Uyarısı:</strong>
            {alerts.map((alt, i) => (
              <div key={i} style={{ marginTop: '2px' }}>{alt}</div>
            ))}
          </div>
        )}

        {/* Aksiyon Butonları (3'lü Grid) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '14px' }}>
          <button
            onClick={() => setShowQr(true)}
            style={{ padding: '8px 4px', backgroundColor: '#1e8e3e', color: 'white', border: 'none', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
          >
            📱 QR Giriş
          </button>
          <button
            onClick={() => setShowFenceModal(true)}
            style={{ padding: '8px 4px', backgroundColor: '#f2994a', color: 'white', border: 'none', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
          >
            ➕ Alan Çiti
          </button>
          <button
            onClick={() => setShowShiftModal(true)}
            style={{ padding: '8px 4px', backgroundColor: '#5f6368', color: 'white', border: 'none', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
          >
            ⏰ Mesai Ayarı
          </button>
        </div>

        {/* Seçili Personel Detay Kartı */}
        {selectedUser && locations[selectedUser] && (
          <div style={{ backgroundColor: '#e8f0fe', border: '1px solid #d2e3fc', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: '16px', color: '#1a73e8' }}>{selectedUser}</strong>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#5f6368' }}>
                🔋 %{locations[selectedUser].battery || 100}
              </span>
            </div>

            <div style={{ fontSize: '13px', marginTop: '6px', fontWeight: '600', color: getSpeedBadge(locations[selectedUser].speed).color }}>
              {getSpeedBadge(locations[selectedUser].speed).icon} {getSpeedBadge(locations[selectedUser].speed).label}
            </div>

            {userSummary && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '10px', fontSize: '12px', backgroundColor: '#fff', padding: '8px', borderRadius: '6px' }}>
                <div>Toplam: <strong>{userSummary.totalKm} km</strong></div>
                <div>Max Hız: <strong>{userSummary.maxSpeed} km/s</strong></div>
              </div>
            )}

            {/* Rota ve Garantili Excel İndirme */}
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              <button
                onClick={() => setShowRoute(!showRoute)}
                style={{ flex: 1, padding: '8px 4px', backgroundColor: showRoute ? '#1a73e8' : '#dadce0', color: showRoute ? '#fff' : '#333', border: 'none', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                {showRoute ? '✓ Rota Açık' : 'Rotayı Göster'}
              </button>
              <button
                onClick={() => handleDownloadCsv(selectedUser)}
                style={{ flex: 1, padding: '8px 4px', backgroundColor: '#137333', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                📥 Excel / CSV İndir
              </button>
            </div>
          </div>
        )}

        <h3 style={{ fontSize: '12px', color: '#5f6368', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          Personel Listesi ({Object.keys(locations).length})
        </h3>

        {Object.keys(locations).length === 0 && (
          <p style={{ color: '#888', fontSize: '13px' }}>Henüz aktif personel konumu yok.</p>
        )}

        {/* Personel Kartları */}
        {Object.entries(locations).map(([userId, loc]) => {
          const online = isOnline(loc.timestamp);
          const speedInfo = getSpeedBadge(loc.speed);
          return (
            <div
              key={userId}
              onClick={() => selectPersonnel(userId)}
              style={{
                marginBottom: '8px',
                padding: '10px 12px',
                border: selectedUser === userId ? '2px solid #1a73e8' : '1px solid #dadce0',
                borderRadius: '8px',
                cursor: 'pointer',
                backgroundColor: selectedUser === userId ? '#e8f0fe' : '#ffffff',
                transition: '0.2s'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ height: '8px', width: '8px', borderRadius: '50%', backgroundColor: online ? '#1e8e3e' : '#80868b' }}></span>
                  <strong style={{ fontSize: '14px', color: '#202124' }}>{userId}</strong>
                </div>
                <small style={{ fontSize: '11px', color: online ? '#1e8e3e' : '#80868b', fontWeight: 'bold' }}>
                  {online ? 'Çevrim içi' : 'Çevrimdışı'}
                </small>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '12px', color: '#5f6368' }}>
                <span>{speedInfo.icon} {speedInfo.label}</span>
                <span>🔋 %{loc.battery || 100}</span>
              </div>

              <div style={{ fontSize: '11px', color: '#80868b', marginTop: '4px' }}>
                Son Sinyal: {loc.timestamp ? new Date(loc.timestamp).toLocaleTimeString() : '-'}
              </div>
            </div>
          );
        })}
      </div>

      {/* Harita */}
      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer center={center} zoom={14} style={{ height: '100%', width: '100%' }}>
          <MapController center={center} zoom={15} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {geofences.map((fence) => (
            <Circle
              key={fence.id}
              center={[fence.latitude, fence.longitude]}
              radius={fence.radius}
              pathOptions={{ color: '#f2994a', fillColor: '#f2994a', fillOpacity: 0.15, dashArray: '5, 5' }}
            >
              <Popup>
                <strong>Bölge Sınırı: {fence.name}</strong><br />
                Yarıçap: {fence.radius} metre
              </Popup>
            </Circle>
          ))}

          {showRoute && routePoints.length > 1 && (
            <Polyline
              positions={routePoints}
              pathOptions={{ color: '#1a73e8', weight: 4, opacity: 0.8 }}
            />
          )}

          {Object.entries(locations).map(([userId, loc]) => (
            <Marker
              key={userId}
              position={[loc.lat, loc.lng]}
              eventHandlers={{ click: () => selectPersonnel(userId) }}
            >
              <Popup>
                <strong>{userId}</strong><br />
                Durum: {getSpeedBadge(loc.speed).label}<br />
                Pil: %{loc.battery || 100}<br />
                Saat: {loc.timestamp ? new Date(loc.timestamp).toLocaleTimeString() : '-'}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* QR Modal */}
      {showQr && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ backgroundColor: 'white', padding: '24px', borderRadius: '12px', textAlign: 'center', maxWidth: '360px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>📱 Personel Giriş Karekodu</h3>
            <p style={{ fontSize: '13px', color: '#666', marginBottom: '16px' }}>Personel telefon kamerasıyla okuttuğunda takip sayfası doğrudan açılır.</p>
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(BACKEND_URL + '/takip.html')}`}
              alt="QR Kod"
              style={{ width: '220px', height: '220px', borderRadius: '8px', border: '1px solid #eee' }}
            />
            <div style={{ fontSize: '11px', color: '#1a73e8', wordBreak: 'break-all', margin: '10px 0 16px 0' }}>{BACKEND_URL}/takip.html</div>
            <button onClick={() => setShowQr(false)} style={{ padding: '8px 16px', backgroundColor: '#dadce0', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>Kapat</button>
          </div>
        </div>
      )}

      {/* Mesai ve İzin Ayarları Modalı */}
      {showShiftModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ backgroundColor: 'white', padding: '24px', borderRadius: '12px', width: '380px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '18px', color: '#202124' }}>⏰ Haftalık Mesai & İzin Ayarları</h3>
            <p style={{ fontSize: '12px', color: '#666', marginBottom: '14px', lineHeight: '1.4' }}>
              Personelin sadece belirlenen çalışma gün ve saatlerinde takip edilmesini sağlar. Hafta sonu izinlerinde takip otomatik durur.
            </p>

            <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '6px' }}>Çalışma Günleri:</label>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
              {ALL_DAYS.map((d) => {
                const active = shiftSettings.activeDays.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDay(d.id)}
                    style={{
                      flex: 1,
                      padding: '8px 0',
                      borderRadius: '6px',
                      border: '1px solid ' + (active ? '#1a73e8' : '#dadce0'),
                      backgroundColor: active ? '#e8f0fe' : '#ffffff',
                      color: active ? '#1a73e8' : '#5f6368',
                      fontWeight: 'bold',
                      cursor: 'pointer',
                      fontSize: '12px'
                    }}
                  >
                    {d.name}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Mesai Başlangıç:</label>
                <input
                  type="time"
                  value={shiftSettings.startTime}
                  onChange={(e) => setShiftSettings({ ...shiftSettings, startTime: e.target.value })}
                  style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '6px', fontSize: '14px' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Mesai Bitiş:</label>
                <input
                  type="time"
                  value={shiftSettings.endTime}
                  onChange={(e) => setShiftSettings({ ...shiftSettings, endTime: e.target.value })}
                  style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '6px', fontSize: '14px' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px', padding: '10px', backgroundColor: '#f8f9fa', borderRadius: '6px' }}>
              <input
                type="checkbox"
                id="block-check"
                checked={shiftSettings.blockOffShift}
                onChange={(e) => setShiftSettings({ ...shiftSettings, blockOffShift: e.target.checked })}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              <label htmlFor="block-check" style={{ fontSize: '12px', color: '#202124', cursor: 'pointer' }}>
                <strong>İzinli günlerde ve mesai dışında takibi tamamen durdur</strong> (Personel gizliliği ve batarya koruma)
              </label>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleSaveShiftSettings}
                style={{ flex: 1, padding: '10px', backgroundColor: '#1a73e8', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '13px' }}
              >
                Ayarları Kaydet
              </button>
              <button
                onClick={() => setShowShiftModal(false)}
                style={{ padding: '10px 16px', backgroundColor: '#eee', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}
              >
                İptal
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Geofence Modal */}
      {showFenceModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ backgroundColor: 'white', padding: '24px', borderRadius: '12px', width: '320px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '17px' }}>➕ Yeni Çalışma Alanı (Çit)</h3>
            <p style={{ fontSize: '12px', color: '#666', marginBottom: '12px' }}>
              Seçili personelin bulunduğu konumu merkez alarak sınır çizer. Personel bu alandan çıkarsa alarm çalar.
            </p>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Bölge Adı:</label>
            <input
              type="text"
              value={newFenceName}
              onChange={(e) => setNewFenceName(e.target.value)}
              style={{ width: '100%', padding: '8px', marginTop: '4px', marginBottom: '12px', border: '1px solid #ccc', borderRadius: '4px' }}
            />
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Yarıçap (Metre):</label>
            <input
              type="number"
              value={newFenceRadius}
              onChange={(e) => setNewFenceRadius(e.target.value)}
              style={{ width: '100%', padding: '8px', marginTop: '4px', marginBottom: '16px', border: '1px solid #ccc', borderRadius: '4px' }}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={handleAddGeofence} style={{ flex: 1, padding: '10px', backgroundColor: '#f2994a', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>Alanı Kaydet</button>
              <button onClick={() => setShowFenceModal(false)} style={{ padding: '10px', backgroundColor: '#eee', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>İptal</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
