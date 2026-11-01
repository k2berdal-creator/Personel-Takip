require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// HTML sayfaları için tarayıcı önbelleğini engelle (Canlı sürüm garantisi)
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Statik panel onceligi: Derlenmis React admin paneli (admin-panel/dist)
const adminDistPath = path.join(__dirname, '../admin-panel/dist');
if (fs.existsSync(adminDistPath)) {
  console.log('[PROD] React Admin Panel (admin-panel/dist) statik olarak sunuluyor.');
  app.use(express.static(adminDistPath));
}

// Mobil istemci ve diger statik dosyalar (index.html haric):
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// RAM onbellegi (Hizli erisim icin)
const activeLocations = {};

// Akilli Saha ve Guvenlik Takipcileri
const activeCustomerVisits = {}; // { [userId]: { customerId, customerName, entryTime } }
const lastSpeedRecord = {};      // { [userId]: { speed, time } }
const stillnessTracker = {};      // { [userId]: { lat, lon, since } }

// Sunucu acildiginda DB'deki son bilinen durumlari onbellegi yukle
try {
  const saved = db.getLatestLocations();
  saved.forEach((loc) => {
    activeLocations[loc.userId] = {
      userId: loc.userId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      speed: loc.speed || 0,
      battery: loc.battery || 100,
      timestamp: loc.timestamp
    };
  });
  console.log(`[DB] ${Object.keys(activeLocations).length} personelin son konumu yuklendi.`);
} catch (e) {}

// Gelen konumu kaydet ve islet
function processLocation(userId, lat, lon, speed = 0, battery = 100, timestamp = null) {
  const ts = timestamp || new Date().toISOString();
  const spd = Number(speed) || 0;
  const bat = Number(battery) || 100;

  const payload = {
    userId,
    latitude: Number(lat),
    longitude: Number(lon),
    speed: spd,
    battery: bat,
    timestamp: ts
  };

  // RAM guncelle
  activeLocations[userId] = payload;

  // DB'ye kalici yaz
  db.saveLocation(userId, payload.latitude, payload.longitude, spd, bat, ts);

  // Coğrafi çit kontrolü
  const geofences = db.getGeofences();
  geofences.forEach((fence) => {
    const dist = db.calculateDistanceMeters(payload.latitude, payload.longitude, fence.latitude, fence.longitude);
    if (dist > fence.radius) {
      io.emit('geofenceAlert', {
        type: 'EXIT',
        userId,
        fenceName: fence.name,
        distance: Math.round(dist - fence.radius),
        timestamp: ts
      });
    }
  });

  // 1. Müşteri / Şantiye (POI) Otomatik Giriş-Çıkış (Check-in / Check-out)
  try {
    const customers = db.getCustomers();
    let currentInCustomer = null;

    customers.forEach((cust) => {
      const d = db.calculateDistanceMeters(payload.latitude, payload.longitude, cust.latitude, cust.longitude);
      if (d <= (cust.radius || 150)) {
        currentInCustomer = cust;
      }
    });

    const activeVisit = activeCustomerVisits[userId];

    if (currentInCustomer) {
      if (!activeVisit || activeVisit.customerId !== currentInCustomer.id) {
        // Yeni müşteri alanına giriş yaptı
        activeCustomerVisits[userId] = {
          customerId: currentInCustomer.id,
          customerName: currentInCustomer.name,
          entryTime: ts
        };
        io.emit('customerVisitAlert', {
          type: 'CHECK_IN',
          userId,
          customerName: currentInCustomer.name,
          time: ts
        });
        console.log(`[🏢 CHECK-IN] ${userId} -> ${currentInCustomer.name} noktasına giriş yaptı.`);
      }
    } else if (activeVisit) {
      // Müşteri noktasından çıktı -> Ziyaret süresini kaydet
      const entryDate = new Date(activeVisit.entryTime).getTime();
      const exitDate = new Date(ts).getTime();
      const durationMin = Math.round((exitDate - entryDate) / (1000 * 60));

      if (durationMin >= 1) { // 1 dakikadan fazla kaldıysa kayda değer
        db.recordVisit(
          activeVisit.customerId,
          activeVisit.customerName,
          userId,
          activeVisit.entryTime,
          ts,
          durationMin
        );
        io.emit('customerVisitAlert', {
          type: 'CHECK_OUT',
          userId,
          customerName: activeVisit.customerName,
          durationMinutes: durationMin,
          time: ts
        });
        console.log(`[🏢 CHECK-OUT] ${userId} -> ${activeVisit.customerName} ziyaretini tamamladı (${durationMin} dk).`);
      }
      delete activeCustomerVisits[userId];
    }
  } catch (e) {}

  // 2. Sürüş Güvenliği (Ani İvmelenme / Sert Fren Tespiti)
  try {
    const nowTime = new Date(ts).getTime();
    if (lastSpeedRecord[userId]) {
      const prev = lastSpeedRecord[userId];
      const dt = (nowTime - prev.time) / 1000;
      if (dt > 0.5 && dt < 8) {
        const dSpeed = (spd - prev.speed) / dt;
        if (dSpeed > 18) {
          io.emit('drivingAlert', {
            type: 'HARSH_ACCEL',
            userId,
            speed: spd,
            msg: `⚠️ ANİ HIZLANMA: ${userId} (${Math.round(spd)} km/s)`,
            timestamp: ts
          });
        } else if (dSpeed < -22) {
          io.emit('drivingAlert', {
            type: 'HARSH_BRAKE',
            userId,
            speed: spd,
            msg: `🛑 SERT FREN: ${userId} (${Math.round(spd)} km/s)`,
            timestamp: ts
          });
        }
      }
    }
    lastSpeedRecord[userId] = { speed: spd, time: nowTime };
  } catch (e) {}

  // 3. Hareketsizlik Uyarısı (Man-Down / Still Alert)
  try {
    const shift = db.isWithinShift();
    if (shift.inShift) {
      const nowTime = new Date(ts).getTime();
      if (!stillnessTracker[userId]) {
        stillnessTracker[userId] = { lat, lon, since: nowTime, alerted: false };
      } else {
        const distMoved = db.calculateDistanceMeters(lat, lon, stillnessTracker[userId].lat, stillnessTracker[userId].lon);
        if (distMoved < 15 && spd < 3) {
          const stillMinutes = (nowTime - stillnessTracker[userId].since) / (1000 * 60);
          if (stillMinutes >= 20 && !stillnessTracker[userId].alerted) {
            stillnessTracker[userId].alerted = true;
            io.emit('inactivityAlert', {
              userId,
              minutes: Math.round(stillMinutes),
              latitude: lat,
              longitude: lon,
              timestamp: ts
            });
            console.log(`[🚨 HAREKETSİZLİK] ${userId} ${Math.round(stillMinutes)} dakikadır hareketsiz!`);
          }
        } else {
          stillnessTracker[userId] = { lat, lon, since: nowTime, alerted: false };
        }
      }
    }
  } catch (e) {}

  // Tum panellere canli emit et
  io.emit('locationUpdate', payload);
  return payload;
}

// 1. API Durum kontrolü
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    service: 'personel-takip-backend',
    activeUsers: Object.keys(activeLocations).length,
    shift: db.isWithinShift(),
    timestamp: new Date().toISOString()
  });
});

// 2. Tum aktif son konumlar
app.get('/locations', (req, res) => {
  res.json(activeLocations);
});

// 3. Personelin Gecmis Rotasi (Breadcrumbs / Polyline, Tarih Filtreli)
app.get('/history/:userId', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit) : 1000;
  const date = req.query.date || null;
  const history = db.getHistory(req.params.userId, limit, date);
  res.json(history);
});

// 4. Personelin Gunluk Ozeti (Toplam km, max hiz, aktif sure, Tarih Filtreli)
app.get('/summary/:userId', (req, res) => {
  const date = req.query.date || null;
  const summary = db.getDailySummary(req.params.userId, date);
  res.json(summary);
});

// 5. Excel / CSV Dokumu (Turkce Excel uyumlu - Noktali virgul ve UTF-8 BOM, Tarih Filtreli)
app.get('/export-csv/:userId', (req, res) => {
  const date = req.query.date || null;
  let history = db.getHistory(req.params.userId, 5000, date);
  if (!history || history.length === 0) {
    if (activeLocations[req.params.userId]) {
      history = [activeLocations[req.params.userId]];
    } else {
      return res.status(404).send('Bu personel icin kayit bulunamadi.');
    }
  }

  let csv = 'Personel;Tarih;Saat;Enlem;Boylam;Hiz (km/s);Pil (%)\n';
  history.forEach((row) => {
    const d = new Date(row.timestamp);
    const dateStr = d.toLocaleDateString('tr-TR');
    const timeStr = d.toLocaleTimeString('tr-TR');
    csv += `"${req.params.userId}";"${dateStr}";"${timeStr}";${row.latitude};${row.longitude};${row.speed || 0};${row.battery || 100}\n`;
  });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(req.params.userId)}_gecmis_rota.csv"`);
  res.send('\uFEFF' + csv);
});

// 5.1 Acil Durum / SOS Bildirimi (RAM, DB ve REST destekli)
let activeSos = null;

app.get('/api/sos', (req, res) => {
  res.json(activeSos);
});

app.delete('/api/sos', (req, res) => {
  activeSos = null;
  io.emit('sosCleared');
  res.json({ status: 'SOS_CLEARED' });
});

app.post('/sos', (req, res) => {
  const { userId, latitude, longitude, speed, battery, timestamp } = req.body;
  const user = userId || 'Saha_Personeli_1';
  const lat = Number(latitude) || 41.042;
  const lon = Number(longitude) || 28.69;
  const spd = Number(speed) || 0;
  const bat = Number(battery) || 100;
  const ts = timestamp || new Date().toISOString();

  // Konumu RAM ve DB'ye hemen isle ki haritada aninda belirtsin
  processLocation(user, lat, lon, spd, bat, ts);

  activeSos = {
    userId: user,
    latitude: lat,
    longitude: lon,
    speed: spd,
    battery: bat,
    timestamp: ts
  };

  io.emit('sosAlert', activeSos);
  console.log(`[🚨 SOS ÇAĞRISI] ${user} acil durum bildirdi! (${lat}, ${lon})`);
  res.json({ status: 'SOS_EMITTED', data: activeSos });
});

// 5.2 Telsiz & Hızlı Mesajlaşma (Dispatch Messaging)
let dispatchMessages = [];

app.get('/api/messages', (req, res) => {
  res.json(dispatchMessages.slice(-50));
});

app.post('/api/message', (req, res) => {
  const { from, target, text } = req.body;
  if (!text) return res.status(400).json({ error: 'Mesaj metni zorunludur' });
  const msg = {
    id: Date.now().toString(),
    from: from || 'Merkez Yönetim',
    target: target || 'ALL',
    text: text.trim(),
    timestamp: new Date().toISOString()
  };
  dispatchMessages.push(msg);
  if (dispatchMessages.length > 200) dispatchMessages.shift();
  io.emit('adminNotice', msg);
  console.log(`[📢 ANONS] ${msg.from} -> ${msg.target}: "${msg.text}"`);
  res.json({ status: 'OK', data: msg });
});

app.post('/api/status-update', (req, res) => {
  const { userId, statusText } = req.body;
  if (!userId || !statusText) return res.status(400).json({ error: 'Eksik bilgi' });
  const payload = {
    userId,
    statusText,
    timestamp: new Date().toISOString()
  };
  if (activeLocations[userId]) {
    activeLocations[userId].statusText = statusText;
  }
  io.emit('fieldStatusUpdate', payload);
  console.log(`[💬 SAHA BİLDİRİMİ] ${userId}: "${statusText}"`);
  res.json({ status: 'OK', data: payload });
});

// 6. Haftalik Calisma ve Mesai Saatleri Ayarlari
app.get('/shift-settings', (req, res) => {
  res.json(db.getShiftSettings());
});

app.post('/shift-settings', (req, res) => {
  const { activeDays, startTime, endTime, blockOffShift } = req.body;
  const updated = db.saveShiftSettings(activeDays, startTime, endTime, blockOffShift);
  io.emit('shiftSettingsUpdate', updated);
  console.log('[MESAİ AYARI] Güncellendi:', updated);
  res.json(updated);
});

app.get('/shift-status', (req, res) => {
  res.json(db.isWithinShift());
});

// 7. Coğrafi Çitler (Geofences) API
app.get('/geofences', (req, res) => {
  res.json(db.getGeofences());
});

app.post('/geofences', (req, res) => {
  const { name, latitude, longitude, radius } = req.body;
  if (!name || !latitude || !longitude || !radius) {
    return res.status(400).json({ error: 'Eksik parametreler.' });
  }
  const updated = db.addGeofence(name, latitude, longitude, radius);
  io.emit('geofencesUpdate', updated);
  res.json(updated);
});

app.delete('/geofences/:id', (req, res) => {
  const updated = db.deleteGeofence(req.params.id);
  io.emit('geofencesUpdate', updated);
  res.json(updated);
});

// 8. HTTP POST ile konum guncelleme (Mesai Kontrollu)
app.post('/update', (req, res) => {
  const { lat, lon, id, speed, battery, timestamp } = req.body;
  const userId = id || 'Personel_1';

  // Mesai ve Calisma Gunleri Kontrolu
  const shiftCheck = db.isWithinShift();
  if (!shiftCheck.inShift) {
    console.log(`[MESAI DISI] ${userId} konumu kaydedilmedi: ${shiftCheck.reason}`);
    return res.status(200).json({ status: 'OFF_SHIFT', message: shiftCheck.reason });
  }

  const payload = processLocation(userId, lat, lon, speed, battery, timestamp);
  console.log(`[POST /update] ${userId} -> ${payload.latitude}, ${payload.longitude} (${payload.speed} km/s, %${payload.battery})`);
  res.status(200).json({ status: 'OK', data: payload });
});

// 8.1 Cevrimdisi Kara Kutu: Toplu Konum Kurtarma (Offline Store & Forward)
app.post('/update-batch', (req, res) => {
  const { points } = req.body;
  if (!Array.isArray(points) || points.length === 0) {
    return res.status(400).json({ error: 'Geçersiz veri' });
  }

  let count = 0;
  points.forEach((p) => {
    if (p.lat && p.lon && p.id) {
      processLocation(p.id, p.lat, p.lon, p.speed || 0, p.battery || 100, p.timestamp);
      count++;
    }
  });

  console.log(`[📦 KARA KUTU KURTARMA] ${count} adet çevrimdışı konum başarıyla işlendi.`);
  res.json({ status: 'OK', processedCount: count });
});

// 8.2 Müşteri & Şantiye Noktaları (POI)
app.get('/api/customers', (req, res) => {
  res.json(db.getCustomers());
});

app.post('/api/customers', (req, res) => {
  const { name, address, latitude, longitude, radius } = req.body;
  if (!name || !latitude || !longitude) {
    return res.status(400).json({ error: 'Eksik bilgi' });
  }
  const updated = db.addCustomer(name, address, latitude, longitude, radius || 150);
  io.emit('customersUpdate', updated);
  res.json(updated);
});

app.delete('/api/customers/:id', (req, res) => {
  const updated = db.deleteCustomer(req.params.id);
  io.emit('customersUpdate', updated);
  res.json(updated);
});

app.get('/api/visits', (req, res) => {
  res.json(db.getVisits(req.query.date, req.query.userId));
});

// 8.3 Fotoğraflı Saha Raporu / Teslimat Tutanağı
app.post('/api/upload-report', (req, res) => {
  const { userId, photo, note, latitude, longitude, timestamp } = req.body;
  if (!userId || !photo) {
    return res.status(400).json({ error: 'Fotoğraf ve personel adı zorunludur' });
  }
  const ts = timestamp || new Date().toISOString();
  db.saveFieldReport(userId, photo, note, latitude, longitude, ts);

  const reportPayload = {
    userId,
    photo,
    note,
    latitude: Number(latitude),
    longitude: Number(longitude),
    timestamp: ts
  };
  io.emit('newFieldReport', reportPayload);
  console.log(`[📸 SAHA RAPORU] ${userId} fotoğraf yükledi: "${note || 'Not yok'}"`);
  res.json({ status: 'OK', data: reportPayload });
});

app.get('/api/reports', (req, res) => {
  res.json(db.getFieldReports());
});

// 8.4 Müşteriye Özel Canlı Takip Sayfası
app.get('/track/:userId', (req, res) => {
  const targetUser = req.params.userId;
  const userLoc = activeLocations[targetUser] || { latitude: 41.04239, longitude: 28.68986, speed: 0 };

  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Canlı Görev & Teslimat Takibi</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, sans-serif; }
    #map { height: 100vh; width: 100vw; }
    .card { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 1000; background: white; border-radius: 14px; padding: 16px 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.25); width: 90%; max-width: 400px; text-align: center; }
    h2 { font-size: 16px; color: #1a73e8; margin-bottom: 6px; }
    .badge { display: inline-block; padding: 4px 10px; background: #e6f4ea; color: #137333; font-weight: bold; font-size: 12px; border-radius: 12px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="card">
    <h2>🚚 ${targetUser} Yolda</h2>
    <div class="badge" id="speed-badge">Hız: ${Math.round(userLoc.speed || 0)} km/s</div>
    <div style="font-size: 12px; color: #5f6368; margin-top: 8px;" id="status-text">Canlı konum izleniyor...</div>
  </div>
  <script>
    const map = L.map('map').setView([${userLoc.latitude}, ${userLoc.longitude}], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

    const carIcon = L.divIcon({
      html: '<div style="font-size: 28px; text-shadow: 0 2px 6px rgba(0,0,0,0.3);">🚗</div>',
      className: '',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const marker = L.marker([${userLoc.latitude}, ${userLoc.longitude}], { icon: carIcon }).addTo(map);
    const socket = io();

    socket.on('locationUpdate', (data) => {
      if (data.userId === '${targetUser}') {
        marker.setLatLng([data.latitude, data.longitude]);
        map.panTo([data.latitude, data.longitude]);
        document.getElementById('speed-badge').textContent = 'Hız: ' + Math.round(data.speed) + ' km/s';
        document.getElementById('status-text').textContent = 'Son güncelleme: ' + new Date(data.timestamp).toLocaleTimeString();
      }
    });
  </script>
</body>
</html>`;
  res.send(html);
});

// 9. Socket.io baglantilari
io.on('connection', (socket) => {
  console.log('Yeni soket baglantisi:', socket.id);

  // Ilk yukleme verileri
  socket.emit('initialLocations', activeLocations);
  socket.emit('geofencesUpdate', db.getGeofences());
  socket.emit('shiftSettingsUpdate', db.getShiftSettings());

  socket.on('sosAlert', (data) => {
    if (!data || !data.userId) return;
    io.emit('sosAlert', data);
    console.log(`[🚨 SOKET SOS] ${data.userId} acil durum çağırdı!`);
  });

  socket.on('updateLocation', (data) => {
    if (!data || !data.userId) return;

    // Mesai kontrolu
    const shiftCheck = db.isWithinShift();
    if (!shiftCheck.inShift) {
      socket.emit('shiftStatus', { inShift: false, message: shiftCheck.reason });
      return;
    }

    processLocation(
      data.userId,
      data.latitude,
      data.longitude,
      data.speed,
      data.battery,
      data.timestamp
    );
  });

  socket.on('fieldStatus', (data) => {
    if (!data || !data.userId) return;
    if (activeLocations[data.userId]) activeLocations[data.userId].statusText = data.statusText;
    io.emit('fieldStatusUpdate', data);
  });

  socket.on('adminNotice', (data) => {
    if (!data || !data.text) return;
    io.emit('adminNotice', data);
  });

  socket.on('disconnect', () => {
    console.log('Soket ayrildi:', socket.id);
  });
});

// SPA ve Statik Rota Yonlendirmesi (Express 5 uyumlu)
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/socket.io') ||
    req.path.startsWith('/locations') ||
    req.path.startsWith('/history') ||
    req.path.startsWith('/summary') ||
    req.path.startsWith('/export-csv') ||
    req.path.startsWith('/shift-') ||
    req.path.startsWith('/geofences') ||
    req.path.startsWith('/update') ||
    req.path.startsWith('/sos') ||
    req.path.startsWith('/track') ||
    req.path.startsWith('/takip') ||
    req.path.startsWith('/manifest') ||
    req.path.startsWith('/sw.js') ||
    req.path.endsWith('.png') ||
    req.path.endsWith('.ico')
  ) {
    return next();
  }

  const adminIndex = path.join(adminDistPath, 'index.html');
  if (fs.existsSync(adminIndex)) {
    return res.sendFile(adminIndex);
  }
  res.sendFile(path.join(__dirname, 'public', 'takip.html'));
});

const PORT = process.env.PORT || 5005;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[HATA] Port ${PORT} su an baska bir program tarafindan kullaniliyor!`);
  } else {
    console.error('\n[HATA] Sunucu baslatilamadi:', err.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` [BASARILI] Personel Takip Backend Calisiyor!`);
  console.log(` Port: ${PORT}`);
  console.log(` Yerel Test Linki: http://localhost:${PORT}/api/status`);
  console.log(`======================================================\n`);
});
