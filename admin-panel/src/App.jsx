import React, { useEffect, useState, useRef } from 'react';
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

const ADMIN_PASSWORD = '751248.Go';

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

// Sesli İkaz (Tarayıcı Yerel Audio API)
function playBeep(freq = 880, duration = 0.25) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

// Siren Alarmı (SOS Acil Durum)
function playSiren() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(500, now);
    osc.frequency.linearRampToValueAtTime(1100, now + 0.3);
    osc.frequency.linearRampToValueAtTime(500, now + 0.6);
    osc.frequency.linearRampToValueAtTime(1100, now + 0.9);
    osc.frequency.linearRampToValueAtTime(500, now + 1.2);
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 1.5);
    osc.start(now);
    osc.stop(now + 1.5);
  } catch (e) {}
}

// İki koordinat arası metre mesafesi (Haversine)
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Duraklama ve Mola Noktalarını Tespit Et (Minimum 4 dk ve 35m yarıçap)
function detectStops(pts, minMinutes = 4, maxDistMeters = 35) {
  if (!pts || pts.length < 2) return [];
  const stops = [];
  let stopStart = null;
  let lastPt = null;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!stopStart) {
      stopStart = p;
      lastPt = p;
      continue;
    }

    const dist = calculateDistanceMeters(stopStart.latitude, stopStart.longitude, p.latitude, p.longitude);
    if (dist <= maxDistMeters) {
      lastPt = p;
    } else {
      const durMinutes = (new Date(lastPt.timestamp) - new Date(stopStart.timestamp)) / 60000;
      if (durMinutes >= minMinutes) {
        stops.push({
          lat: stopStart.latitude,
          lng: stopStart.longitude,
          startTime: stopStart.timestamp,
          endTime: lastPt.timestamp,
          durationMinutes: Math.round(durMinutes)
        });
      }
      stopStart = p;
      lastPt = p;
    }
  }

  if (stopStart && lastPt && stopStart !== lastPt) {
    const durMinutes = (new Date(lastPt.timestamp) - new Date(stopStart.timestamp)) / 60000;
    if (durMinutes >= minMinutes) {
      stops.push({
        lat: stopStart.latitude,
        lng: stopStart.longitude,
        startTime: stopStart.timestamp,
        endTime: lastPt.timestamp,
        durationMinutes: Math.round(durMinutes)
      });
    }
  }

  return stops;
}

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

const MAP_LAYERS = {
  standard: {
    name: '🗺️ Sokak',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap'
  },
  satellite: {
    name: '🛰️ Uydu',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri Satellite'
  },
  dark: {
    name: '🌙 Gece',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap Gece Modu'
  }
};

// Duraklama Marker İkonu
const stopIcon = L.divIcon({
  className: 'stop-icon',
  html: `<div style="background-color: #f2994a; color: white; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.35); font-size: 13px;">P</div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13]
});

// Canlandırma Hareketli Araç İkonu
const playbackVehicleIcon = L.divIcon({
  className: 'playback-marker',
  html: `<div style="background-color: #1a73e8; color: white; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 3px solid white; box-shadow: 0 3px 10px rgba(0,0,0,0.4); font-size: 18px;">🚗</div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17]
});

// SOS Acil Durum İkonu
const sosMarkerIcon = L.divIcon({
  className: 'speed-alert',
  html: `<div style="background-color: #d93025; color: white; width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 3px solid white; box-shadow: 0 0 15px rgba(217,48,37,0.9); font-size: 20px;">🚨</div>`,
  iconSize: [38, 38],
  iconAnchor: [19, 19]
});

export default function App() {
  // 1. Güvenlik / Şifre Girişi
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem('admin_auth_token') === ADMIN_PASSWORD;
  });
  const [inputPassword, setInputPassword] = useState('');
  const [authError, setAuthError] = useState(false);

  // 2. Temel Durumlar
  const [locations, setLocations] = useState({});
  const [selectedUser, setSelectedUser] = useState(null);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [showQr, setShowQr] = useState(false);

  // 3. Rota, Tarih Seçici & Duraklamalar
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rawHistory, setRawHistory] = useState([]);
  const [routePoints, setRoutePoints] = useState([]);
  const [stops, setStops] = useState([]);
  const [showRoute, setShowRoute] = useState(true);
  const [showStops, setShowStops] = useState(true);
  const [userSummary, setUserSummary] = useState(null);

  // 4. Zaman Tüneli / Rota Canlandırıcı (Playback)
  const [isPlaybackOpen, setIsPlaybackOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const playbackTimerRef = useRef(null);

  // 5. Harita Katmanı (Sokak / Uydu / Gece)
  const [currentLayer, setCurrentLayer] = useState('standard');

  // 6. Hız Aşımı & Alarmlar
  const [speedLimit, setSpeedLimit] = useState(80);
  const [alerts, setAlerts] = useState([]);

  // 7. SOS Acil Durum & PDF Rapor Modalları
  const [sosModalData, setSosModalData] = useState(null);
  const [showReportModal, setShowReportModal] = useState(false);

  // 8. Çit & Mesai
  const [geofences, setGeofences] = useState([]);
  const [showFenceModal, setShowFenceModal] = useState(false);
  const [newFenceName, setNewFenceName] = useState('Merkez Şantiye');
  const [newFenceRadius, setNewFenceRadius] = useState('500');

  const [showShiftModal, setShowShiftModal] = useState(false);
  const [shiftSettings, setShiftSettings] = useState({
    activeDays: [1, 2, 3, 4, 5],
    startTime: '08:30',
    endTime: '18:00',
    blockOffShift: true
  });
  const [shiftStatus, setShiftStatus] = useState({ inShift: true });

  // Şifre Giriş Doğrulaması
  const handleLogin = (e) => {
    e.preventDefault();
    if (inputPassword === ADMIN_PASSWORD) {
      localStorage.setItem('admin_auth_token', ADMIN_PASSWORD);
      setIsAuthenticated(true);
      setAuthError(false);
    } else {
      setAuthError(true);
      playBeep(400, 0.3);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('admin_auth_token');
    setIsAuthenticated(false);
    setInputPassword('');
  };

  // Tarih ve Personel Geçmişini Yükle
  const loadPersonnelHistory = (userId, dateStr) => {
    if (!userId) return;
    setIsPlaybackOpen(false);
    setIsPlaying(false);
    setPlaybackIndex(0);

    const queryUrl = `${BACKEND_URL}/history/${encodeURIComponent(userId)}?date=${encodeURIComponent(dateStr)}`;
    fetch(queryUrl)
      .then((res) => res.json())
      .then((pts) => {
        setRawHistory(pts);
        setRoutePoints(pts.map((p) => [p.latitude, p.longitude]));
        const detected = detectStops(pts, 4, 35);
        setStops(detected);
      })
      .catch(() => {
        setRawHistory([]);
        setRoutePoints([]);
        setStops([]);
      });

    fetch(`${BACKEND_URL}/summary/${encodeURIComponent(userId)}?date=${encodeURIComponent(dateStr)}`)
      .then((res) => res.json())
      .then((sum) => setUserSummary(sum))
      .catch(() => setUserSummary(null));
  };

  // Soket ve Veri Dinleyicileri
  useEffect(() => {
    if (!isAuthenticated) return;

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
      const spd = data.speed || 0;

      if (spd > speedLimit) {
        playBeep(920, 0.4);
        const alertMsg = `⚡ HIZ AŞIMI: ${data.userId} ${Math.round(spd)} km/s ile sınırı (${speedLimit} km/s) aştı!`;
        setAlerts((prev) => [alertMsg, ...prev.slice(0, 4)]);
      }

      setLocations((prev) => ({
        ...prev,
        [data.userId]: {
          lat: data.latitude,
          lng: data.longitude,
          speed: spd,
          battery: data.battery || 100,
          timestamp: data.timestamp
        }
      }));

      // Eğer seçili gün bugünün tarihiyse rotayı canlı uzat
      const todayStr = new Date().toISOString().slice(0, 10);
      if (selectedUser === data.userId && selectedDate === todayStr) {
        setRoutePoints((prev) => [...prev, [data.latitude, data.longitude]]);
        setRawHistory((prev) => [...prev, data]);
      }
    };

    const handleGeofenceAlert = (alertData) => {
      playBeep(650, 0.4);
      const msg = `⚠️ BÖLGE İHLALİ: ${alertData.userId}, "${alertData.fenceName}" alanından ${alertData.distance}m dışarı çıktı!`;
      setAlerts((prev) => [msg, ...prev.slice(0, 4)]);
    };

    // SOS Çağrısı Geldiğinde Siren Çal ve Modalı Aç
    const handleSosAlert = (sosData) => {
      playSiren();
      setSosModalData(sosData);
      const msg = `🚨 ACİL DURUM (SOS): ${sosData.userId} YARDIM ÇAĞRISI GÖNDERDİ!`;
      setAlerts((prev) => [msg, ...prev]);
    };

    const handleGeofencesUpdate = (fences) => setGeofences(fences || []);
    const handleShiftSettingsUpdate = (settings) => setShiftSettings(settings);

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('initialLocations', handleInitialLocations);
    socket.on('locationUpdate', handleLocationUpdate);
    socket.on('geofenceAlert', handleGeofenceAlert);
    socket.on('sosAlert', handleSosAlert);
    socket.on('geofencesUpdate', handleGeofencesUpdate);
    socket.on('shiftSettingsUpdate', handleShiftSettingsUpdate);

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
      socket.off('sosAlert', handleSosAlert);
      socket.off('geofencesUpdate', handleGeofencesUpdate);
      socket.off('shiftSettingsUpdate', handleShiftSettingsUpdate);
    };
  }, [selectedUser, selectedDate, speedLimit, isAuthenticated]);

  // Personel Seçimi
  const selectPersonnel = (userId) => {
    setSelectedUser(userId);
    loadPersonnelHistory(userId, selectedDate);
  };

  // Rota Oynatma Motoru (Playback Timer)
  useEffect(() => {
    if (isPlaying && isPlaybackOpen && rawHistory.length > 0) {
      playbackTimerRef.current = setInterval(() => {
        setPlaybackIndex((prev) => {
          if (prev >= rawHistory.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, Math.max(100, Math.round(1000 / playbackSpeed)));
    } else {
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
    }
    return () => {
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
    };
  }, [isPlaying, isPlaybackOpen, playbackSpeed, rawHistory.length]);

  // CSV İndirme (Tarih Filtreli)
  const handleDownloadCsv = async (userId) => {
    try {
      const res = await fetch(`${BACKEND_URL}/export-csv/${encodeURIComponent(userId)}?date=${encodeURIComponent(selectedDate)}`);
      if (!res.ok) {
        alert('Bu personel için seçili tarihte hareket verisi bulunamadı.');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${userId}_Gecmis_Rota_${selectedDate}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      alert('İndirme hatası: ' + e.message);
    }
  };

  // Çit Ekleme
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

  // Mesai Kaydet
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

  // Oynatma noktasındaki anlık koordinat veya canlı merkez
  const currentPlaybackPoint =
    isPlaybackOpen && rawHistory.length > 0 && rawHistory[playbackIndex]
      ? [rawHistory[playbackIndex].latitude, rawHistory[playbackIndex].longitude]
      : null;

  const center =
    currentPlaybackPoint ||
    (selectedUser && locations[selectedUser]
      ? [locations[selectedUser].lat, locations[selectedUser].lng]
      : Object.keys(locations).length > 0
      ? [Object.values(locations)[0].lat, Object.values(locations)[0].lng]
      : [41.042, 28.69]);

  // GİRİŞ EKRANI (Eğer Giriş Yapılmadıysa)
  if (!isAuthenticated) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: '#1e242b',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      }}>
        <div style={{
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '36px 32px',
          width: '100%',
          maxWidth: '380px',
          boxShadow: '0 12px 36px rgba(0,0,0,0.3)',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '42px', marginBottom: '12px' }}>🛡️</div>
          <h2 style={{ margin: '0 0 6px 0', color: '#1c2b22', fontSize: '22px', fontWeight: 'bold' }}>
            Personel Takip Paneli
          </h2>
          <p style={{ margin: '0 0 24px 0', fontSize: '13px', color: '#5f6368' }}>
            Yönetici Güvenlik Girişi
          </p>

          <form onSubmit={handleLogin}>
            <div style={{ textAlign: 'left', marginBottom: '16px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold', color: '#3c4043', display: 'block', marginBottom: '6px' }}>
                Yönetici Şifresi:
              </label>
              <input
                type="password"
                placeholder="Şifreyi giriniz"
                value={inputPassword}
                onChange={(e) => setInputPassword(e.target.value)}
                autoFocus
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  border: authError ? '2px solid #d93025' : '1px solid #dadce0',
                  borderRadius: '8px',
                  fontSize: '15px',
                  boxSizing: 'border-box',
                  outline: 'none'
                }}
              />
              {authError && (
                <div style={{ color: '#d93025', fontSize: '12px', marginTop: '6px', fontWeight: '600' }}>
                  ⚠️ Hatalı şifre, lütfen tekrar deneyin.
                </div>
              )}
            </div>

            <button
              type="submit"
              style={{
                width: '100%',
                padding: '14px',
                backgroundColor: '#1a73e8',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '15px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: '0.2s',
                boxShadow: '0 2px 6px rgba(26,115,232,0.3)'
              }}
            >
              Giriş Yap
            </button>
          </form>

          <div style={{ marginTop: '20px', fontSize: '11px', color: '#80868b' }}>
            Saha Personel Takip Sistemi &bull; Bulut Yönetim Arayüzü
          </div>
        </div>
      </div>
    );
  }

  // YÖNETİM PANELİ ANA EKRANI
  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      
      {/* SOL PANEL (KONTROL MERKEZİ) */}
      <div style={{ width: '390px', borderRight: '1px solid #e0e0e0', padding: '16px', overflowY: 'auto', backgroundColor: '#fafafa', display: 'flex', flexDirection: 'column' }}>
        
        {/* Üst Bar & Çıkış */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h2 style={{ fontSize: '18px', margin: 0, color: '#202124' }}>Personel Takip</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
            <button
              onClick={handleLogout}
              title="Güvenli Çıkış"
              style={{
                fontSize: '11px',
                padding: '4px 8px',
                backgroundColor: '#f1f3f4',
                color: '#d93025',
                border: '1px solid #dadce0',
                borderRadius: '6px',
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              Çıkış
            </button>
          </div>
        </div>

        {/* Mesai ve Hız Sınırı Rozetleri */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
          <span style={{
            flex: 1,
            textAlign: 'center',
            fontSize: '11px',
            padding: '5px',
            borderRadius: '6px',
            backgroundColor: shiftStatus.inShift ? '#e6f4ea' : '#feefe3',
            color: shiftStatus.inShift ? '#137333' : '#b06000',
            fontWeight: 'bold'
          }}>
            {shiftStatus.inShift ? '🟢 Mesai İçi' : '⏰ Mesai Dışı'}
          </span>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', backgroundColor: '#f8f9fa', border: '1px solid #dadce0', borderRadius: '6px', padding: '4px', fontSize: '11px' }}>
            <span>⚡ Hız Limiti:</span>
            <input
              type="number"
              value={speedLimit}
              onChange={(e) => setSpeedLimit(Number(e.target.value) || 50)}
              style={{ width: '42px', padding: '2px 4px', fontSize: '11px', fontWeight: 'bold', border: '1px solid #ccc', borderRadius: '4px', textAlign: 'center' }}
            />
            <span>km/s</span>
          </div>
        </div>

        {/* Alarmlar (Hız Aşımı ve Çit İhlali) */}
        {alerts.length > 0 && (
          <div style={{ backgroundColor: '#fce8e6', border: '1px solid #fad2cf', borderRadius: '8px', padding: '8px 12px', marginBottom: '12px', fontSize: '12px', color: '#c5221f' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <strong>⚠️ Canlı İkazlar ({alerts.length}):</strong>
              <button onClick={() => setAlerts([])} style={{ border: 'none', background: 'none', color: '#999', cursor: 'pointer', fontSize: '11px' }}>Temizle</button>
            </div>
            {alerts.map((alt, i) => (
              <div key={i} style={{ marginTop: '2px', fontWeight: '500' }}>{alt}</div>
            ))}
          </div>
        )}

        {/* Aksiyon Butonları (Grid) */}
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

            <div style={{
              fontSize: '13px',
              marginTop: '6px',
              fontWeight: '600',
              color: locations[selectedUser].speed > speedLimit ? '#d93025' : getSpeedBadge(locations[selectedUser].speed).color
            }}>
              {locations[selectedUser].speed > speedLimit ? '⚡ AŞIRI HIZ: ' : getSpeedBadge(locations[selectedUser].speed).icon + ' '}
              {getSpeedBadge(locations[selectedUser].speed).label}
            </div>

            {/* Tarih Seçici (Date Picker) */}
            <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: '#ffffff', padding: '6px 8px', borderRadius: '6px', fontSize: '12px', border: '1px solid #dadce0' }}>
              <span style={{ fontWeight: 'bold', color: '#3c4043' }}>📅 Rota Tarihi:</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value);
                  loadPersonnelHistory(selectedUser, e.target.value);
                }}
                style={{ flex: 1, padding: '4px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold' }}
              />
            </div>

            {userSummary && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '8px', fontSize: '12px', backgroundColor: '#fff', padding: '8px', borderRadius: '6px' }}>
                <div>Toplam: <strong>{userSummary.totalKm} km</strong></div>
                <div>Max Hız: <strong>{userSummary.maxSpeed} km/s</strong></div>
              </div>
            )}

            {/* Rota ve Mola Gösterim Butonları */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '10px' }}>
              <button
                onClick={() => setShowRoute(!showRoute)}
                style={{ padding: '8px 4px', backgroundColor: showRoute ? '#1a73e8' : '#dadce0', color: showRoute ? '#fff' : '#333', border: 'none', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                {showRoute ? '✓ Rota Açık' : 'Rotayı Göster'}
              </button>
              <button
                onClick={() => setShowStops(!showStops)}
                style={{ padding: '8px 4px', backgroundColor: showStops ? '#f2994a' : '#dadce0', color: showStops ? '#fff' : '#333', border: 'none', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                {showStops ? `✓ Molalar (${stops.length})` : `Molaları Göster (${stops.length})`}
              </button>
            </div>

            {/* Canlandırıcı & Raporlama Butonları (Grid) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', marginTop: '6px' }}>
              <button
                onClick={() => {
                  if (rawHistory.length === 0) {
                    alert('Bu personel için seçili tarihte kaydedilmiş rota bulunmuyor.');
                    return;
                  }
                  setIsPlaybackOpen(true);
                  setPlaybackIndex(0);
                  setIsPlaying(true);
                }}
                style={{ padding: '8px 2px', backgroundColor: '#673ab7', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                🎬 Canlandır
              </button>
              <button
                onClick={() => handleDownloadCsv(selectedUser)}
                style={{ padding: '8px 2px', backgroundColor: '#137333', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                📥 Excel
              </button>
              <button
                onClick={() => setShowReportModal(true)}
                style={{ padding: '8px 2px', backgroundColor: '#0288d1', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                📄 PDF Karne
              </button>
            </div>
          </div>
        )}

        {/* Personel Listesi */}
        <h3 style={{ fontSize: '12px', color: '#5f6368', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          Personel Listesi ({Object.keys(locations).length})
        </h3>

        {Object.keys(locations).length === 0 && (
          <p style={{ color: '#888', fontSize: '13px' }}>Henüz aktif personel konumu yok.</p>
        )}

        {Object.entries(locations).map(([userId, loc]) => {
          const online = isOnline(loc.timestamp);
          const speedInfo = getSpeedBadge(loc.speed);
          const isSpeeding = loc.speed > speedLimit;

          return (
            <div
              key={userId}
              onClick={() => selectPersonnel(userId)}
              className={isSpeeding ? 'speed-alert' : ''}
              style={{
                marginBottom: '8px',
                padding: '10px 12px',
                border: isSpeeding
                  ? '2px solid #d93025'
                  : selectedUser === userId
                  ? '2px solid #1a73e8'
                  : '1px solid #dadce0',
                borderRadius: '8px',
                cursor: 'pointer',
                backgroundColor: isSpeeding ? '#fce8e6' : selectedUser === userId ? '#e8f0fe' : '#ffffff',
                transition: '0.2s'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ height: '8px', width: '8px', borderRadius: '50%', backgroundColor: online ? '#1e8e3e' : '#80868b' }}></span>
                  <strong style={{ fontSize: '14px', color: '#202124' }}>{userId}</strong>
                </div>
                <small style={{ fontSize: '11px', color: isSpeeding ? '#d93025' : online ? '#1e8e3e' : '#80868b', fontWeight: 'bold' }}>
                  {isSpeeding ? '⚡ HIZ AŞIMI' : online ? 'Çevrim içi' : 'Çevrimdışı'}
                </small>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '12px', color: '#5f6368' }}>
                <span style={{ fontWeight: isSpeeding ? 'bold' : 'normal', color: isSpeeding ? '#d93025' : speedInfo.color }}>
                  {speedInfo.icon} {Math.round(loc.speed)} km/s
                </span>
                <span>🔋 %{loc.battery || 100}</span>
              </div>

              <div style={{ fontSize: '11px', color: '#80868b', marginTop: '4px' }}>
                Son Sinyal: {loc.timestamp ? new Date(loc.timestamp).toLocaleTimeString() : '-'}
              </div>
            </div>
          );
        })}
      </div>

      {/* SAĞ PANEL: HARİTA & OVERLAY'LER */}
      <div style={{ flex: 1, position: 'relative' }}>
        
        {/* Harita Katman Değiştirici (Sağ Üst) */}
        <div style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          zIndex: 1000,
          backgroundColor: 'white',
          borderRadius: '8px',
          padding: '4px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          display: 'flex',
          gap: '4px'
        }}>
          {Object.entries(MAP_LAYERS).map(([key, layer]) => (
            <button
              key={key}
              onClick={() => setCurrentLayer(key)}
              style={{
                padding: '6px 10px',
                border: 'none',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
                backgroundColor: currentLayer === key ? '#1a73e8' : 'transparent',
                color: currentLayer === key ? '#ffffff' : '#3c4043',
                transition: '0.2s'
              }}
            >
              {layer.name}
            </button>
          ))}
        </div>

        {/* ZAMAN TÜNELİ / ROTA OYNATICI (Alt Bar) */}
        {isPlaybackOpen && rawHistory.length > 0 && (
          <div style={{
            position: 'absolute',
            bottom: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            padding: '14px 20px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            width: '90%',
            maxWidth: '680px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1a73e8' }}>
                  🎬 Rota Canlandırma: {selectedUser} ({selectedDate})
                </span>
                <span style={{ fontSize: '12px', color: '#5f6368', backgroundColor: '#f1f3f4', padding: '2px 8px', borderRadius: '10px' }}>
                  🕒 {rawHistory[playbackIndex]?.timestamp ? new Date(rawHistory[playbackIndex].timestamp).toLocaleTimeString() : '-'}
                </span>
                <span style={{ fontSize: '12px', color: '#5f6368', backgroundColor: '#f1f3f4', padding: '2px 8px', borderRadius: '10px' }}>
                  🚗 {Math.round(rawHistory[playbackIndex]?.speed || 0)} km/s
                </span>
              </div>

              <button
                onClick={() => { setIsPlaybackOpen(false); setIsPlaying(false); }}
                style={{ border: 'none', background: 'none', fontSize: '16px', color: '#888', cursor: 'pointer', fontWeight: 'bold' }}
              >
                ✕
              </button>
            </div>

            {/* Zaman Çubuğu (Slider) */}
            <input
              type="range"
              min="0"
              max={rawHistory.length - 1}
              value={playbackIndex}
              onChange={(e) => setPlaybackIndex(Number(e.target.value))}
              style={{ width: '100%', cursor: 'pointer' }}
            />

            {/* Oynatma Kontrolleri */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '2px' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => setPlaybackIndex(0)}
                  title="Başa Sar"
                  style={{ padding: '6px 12px', backgroundColor: '#f1f3f4', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
                >
                  ⏮ Başa Sar
                </button>
                <button
                  onClick={() => setIsPlaying(!isPlaying)}
                  style={{
                    padding: '6px 16px',
                    backgroundColor: isPlaying ? '#d93025' : '#1e8e3e',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}
                >
                  {isPlaying ? '⏸ Duraklat' : '▶ Oynat'}
                </button>
              </div>

              {/* Hız Seçenekleri */}
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', color: '#888', marginRight: '4px' }}>Hız:</span>
                {[1, 2, 5, 10].map((spd) => (
                  <button
                    key={spd}
                    onClick={() => setPlaybackSpeed(spd)}
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: '1px solid ' + (playbackSpeed === spd ? '#1a73e8' : '#dadce0'),
                      backgroundColor: playbackSpeed === spd ? '#e8f0fe' : '#ffffff',
                      color: playbackSpeed === spd ? '#1a73e8' : '#5f6368',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      cursor: 'pointer'
                    }}
                  >
                    {spd}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* HARİTA BİLEŞENİ */}
        <MapContainer center={center} zoom={14} style={{ height: '100%', width: '100%' }}>
          <MapController center={center} zoom={15} />
          
          <TileLayer
            key={currentLayer}
            className={currentLayer === 'dark' ? 'dark-tiles' : ''}
            attribution={MAP_LAYERS[currentLayer].attribution}
            url={MAP_LAYERS[currentLayer].url}
            maxZoom={19}
          />

          {/* Coğrafi Çit Çemberleri */}
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

          {/* Rota Çizgisi (Polyline) */}
          {showRoute && routePoints.length > 1 && (
            <Polyline
              positions={routePoints}
              pathOptions={{ color: '#1a73e8', weight: 4, opacity: 0.8 }}
            />
          )}

          {/* Duraklama ve Mola Noktaları (P Marker'ları) */}
          {showStops && stops.map((st, idx) => (
            <Marker key={idx} position={[st.lat, st.lng]} icon={stopIcon}>
              <Popup>
                <div style={{ fontSize: '13px' }}>
                  <strong style={{ color: '#f2994a' }}>🅿️ Duraklama / Mola</strong><br />
                  <strong>Süre:</strong> {st.durationMinutes} Dakika<br />
                  <strong>Giriş:</strong> {new Date(st.startTime).toLocaleTimeString()}<br />
                  <strong>Çıkış:</strong> {new Date(st.endTime).toLocaleTimeString()}
                </div>
              </Popup>
            </Marker>
          ))}

          {/* Oynatıcı Hareketli Araç Marker'ı */}
          {isPlaybackOpen && currentPlaybackPoint && (
            <Marker position={currentPlaybackPoint} icon={playbackVehicleIcon}>
              <Popup>
                <strong>{selectedUser} (Canlandırma)</strong><br />
                Saat: {new Date(rawHistory[playbackIndex].timestamp).toLocaleTimeString()}<br />
                Hız: {Math.round(rawHistory[playbackIndex].speed || 0)} km/s<br />
                Pil: %{rawHistory[playbackIndex].battery || 100}
              </Popup>
            </Marker>
          )}

          {/* SOS Acil Durum Özel Marker'ı */}
          {sosModalData && (
            <Marker position={[sosModalData.latitude, sosModalData.longitude]} icon={sosMarkerIcon}>
              <Popup>
                <strong style={{ color: '#d93025' }}>🚨 ACİL DURUM: {sosModalData.userId}</strong><br />
                Saat: {new Date(sosModalData.timestamp).toLocaleTimeString()}<br />
                Enlem: {sosModalData.latitude.toFixed(5)}<br />
                Boylam: {sosModalData.longitude.toFixed(5)}
              </Popup>
            </Marker>
          )}

          {/* Canlı Personel Konum Marker'ları */}
          {!isPlaybackOpen && Object.entries(locations).map(([userId, loc]) => (
            <Marker
              key={userId}
              position={[loc.lat, loc.lng]}
              eventHandlers={{ click: () => selectPersonnel(userId) }}
            >
              <Popup>
                <strong>{userId}</strong><br />
                Durum: {getSpeedBadge(loc.speed).label}<br />
                Hız: {Math.round(loc.speed)} km/s<br />
                Pil: %{loc.battery || 100}<br />
                Saat: {loc.timestamp ? new Date(loc.timestamp).toLocaleTimeString() : '-'}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* SOS ACİL DURUM BİLDİRİM MODALI */}
      {sosModalData && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(217, 48, 37, 0.45)',
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(3px)'
        }}>
          <div style={{
            backgroundColor: '#ffffff',
            border: '3px solid #d93025',
            borderRadius: '16px',
            padding: '28px',
            maxWidth: '420px',
            width: '90%',
            textAlign: 'center',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)'
          }}>
            <div style={{ fontSize: '50px', marginBottom: '8px' }}>🚨</div>
            <h2 style={{ color: '#d93025', margin: '0 0 10px 0', fontSize: '24px' }}>ACİL DURUM ALARMI (SOS)</h2>
            <p style={{ fontSize: '15px', color: '#202124', margin: '0 0 14px 0' }}>
              <strong>{sosModalData.userId}</strong> acil yardım çağrısında bulundu!
            </p>
            <div style={{ backgroundColor: '#fce8e6', borderRadius: '8px', padding: '12px', textAlign: 'left', fontSize: '13px', marginBottom: '18px', color: '#5f6368', lineHeight: '1.6' }}>
              <div><strong>Saat:</strong> {new Date(sosModalData.timestamp).toLocaleTimeString()}</div>
              <div><strong>Koordinat:</strong> {sosModalData.latitude.toFixed(5)}, {sosModalData.longitude.toFixed(5)}</div>
              <div><strong>Pil Seviyesi:</strong> %{sosModalData.battery || 100}</div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => {
                  setSelectedUser(sosModalData.userId);
                  setLocations(prev => ({
                    ...prev,
                    [sosModalData.userId]: { lat: sosModalData.latitude, lng: sosModalData.longitude, speed: 0, battery: sosModalData.battery, timestamp: sosModalData.timestamp }
                  }));
                }}
                style={{ flex: 1, padding: '12px', backgroundColor: '#1a73e8', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                Haritada Odaklan
              </button>
              <button
                onClick={() => setSosModalData(null)}
                style={{ padding: '12px 20px', backgroundColor: '#d93025', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                Sustur & Kapat
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PDF VARDİYA KARNESİ MODALI (YAZDIRILABİLİR) */}
      {showReportModal && selectedUser && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0,0,0,0.6)',
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflowY: 'auto',
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            padding: '30px',
            maxWidth: '650px',
            width: '100%',
            boxShadow: '0 8px 30px rgba(0,0,0,0.3)'
          }}>
            {/* Rapor Başlığı */}
            <div style={{ borderBottom: '2px solid #1a73e8', paddingBottom: '12px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 style={{ margin: 0, color: '#1a73e8', fontSize: '20px' }}>PERSONEL GÜNLÜK VARDİYA KARNESİ</h2>
                <small style={{ color: '#5f6368' }}>Saha Hareket ve Mesai Denetim Raporu</small>
              </div>
              <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#202124' }}>Tarih: {selectedDate}</span>
            </div>

            {/* Personel & Özet Tablosu */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px', backgroundColor: '#f8f9fa', padding: '16px', borderRadius: '8px' }}>
              <div><strong>Personel Adı:</strong> {selectedUser}</div>
              <div><strong>Toplam Mesafe:</strong> {userSummary?.totalKm || '0'} km</div>
              <div><strong>Maksimum Hız:</strong> {userSummary?.maxSpeed || '0'} km/s</div>
              <div><strong>Toplam Mola Sayısı:</strong> {stops.length} Adet</div>
              <div><strong>İlk Sinyal (Mesai Başlangıç):</strong> {userSummary?.startTime ? new Date(userSummary.startTime).toLocaleTimeString() : '-'}</div>
              <div><strong>Son Sinyal (Mesai Bitiş):</strong> {userSummary?.endTime ? new Date(userSummary.endTime).toLocaleTimeString() : '-'}</div>
            </div>

            {/* Mola ve Duraklamalar Tablosu */}
            <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#202124' }}>Günün Mola ve Duraklamaları ({stops.length}):</h4>
            {stops.length === 0 ? (
              <p style={{ fontSize: '12px', color: '#777', marginBottom: '20px' }}>Bu tarihte kayıtlı duraklama/mola tespit edilmedi.</p>
            ) : (
              <div style={{ maxHeight: '140px', overflowY: 'auto', marginBottom: '20px', border: '1px solid #eee', borderRadius: '6px' }}>
                <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f1f3f4', borderBottom: '1px solid #ddd' }}>
                      <th style={{ padding: '6px 10px' }}>Başlangıç</th>
                      <th style={{ padding: '6px 10px' }}>Bitiş</th>
                      <th style={{ padding: '6px 10px' }}>Mola Süresi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stops.map((s, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '6px 10px' }}>{new Date(s.startTime).toLocaleTimeString()}</td>
                        <td style={{ padding: '6px 10px' }}>{new Date(s.endTime).toLocaleTimeString()}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 'bold', color: '#f2994a' }}>{s.durationMinutes} Dakika</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* İmza Alanı */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px', marginTop: '30px', paddingTop: '20px', borderTop: '1px dashed #ccc' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#555' }}>Teslim Eden Personel</div>
                <div style={{ height: '40px' }}></div>
                <div style={{ borderTop: '1px solid #999', fontSize: '11px', color: '#777' }}>İmza</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#555' }}>Saha Yöneticisi / Amir</div>
                <div style={{ height: '40px' }}></div>
                <div style={{ borderTop: '1px solid #999', fontSize: '11px', color: '#777' }}>İmza / Kaşe</div>
              </div>
            </div>

            {/* Aksiyon Butonları */}
            <div style={{ display: 'flex', gap: '10px', marginTop: '24px' }}>
              <button
                onClick={() => window.print()}
                style={{ flex: 1, padding: '12px', backgroundColor: '#1a73e8', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}
              >
                🖨️ Yazdır / PDF Olarak Kaydet
              </button>
              <button
                onClick={() => setShowReportModal(false)}
                style={{ padding: '12px 20px', backgroundColor: '#eee', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}
              >
                Kapat
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR MODAL */}
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

      {/* MESAİ & İZİN MODAL */}
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
                <strong>İzinli günlerde ve mesai dışında takibi tamamen durdur</strong>
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

      {/* ÇİT ALANI EKLEME MODAL */}
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
