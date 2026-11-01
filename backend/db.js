const path = require('path');
const fs = require('fs');

let db = null;
let useJsonFallback = false;
const jsonDbPath = path.join(__dirname, 'data_store.json');

// Node 22+ built-in SQLite destegi
try {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(__dirname, 'database.sqlite');
  db = new DatabaseSync(dbPath);

  // Tablolari olustur
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      speed REAL DEFAULT 0,
      battery INTEGER DEFAULT 100,
      timestamp TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_user_time ON locations(userId, timestamp);

    CREATE TABLE IF NOT EXISTS geofences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shift_settings (
      id INTEGER PRIMARY KEY,
      activeDays TEXT NOT NULL,
      startTime TEXT NOT NULL,
      endTime TEXT NOT NULL,
      blockOffShift INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius REAL DEFAULT 150,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS field_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      photo TEXT NOT NULL,
      note TEXT DEFAULT '',
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      timestamp TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customerId INTEGER,
      customerName TEXT NOT NULL,
      userId TEXT NOT NULL,
      entryTime TEXT NOT NULL,
      exitTime TEXT,
      durationMinutes INTEGER DEFAULT 0,
      date TEXT NOT NULL
    );
  `);

  // Varsayilan mesai saatleri ekle (Pazartesi-Cuma: 08:30 - 18:00)
  const existingShift = db.prepare('SELECT * FROM shift_settings WHERE id = 1').all();
  if (existingShift.length === 0) {
    db.prepare(`
      INSERT INTO shift_settings (id, activeDays, startTime, endTime, blockOffShift)
      VALUES (1, '[1,2,3,4,5]', '08:30', '18:00', 1)
    `).run();
  }

  console.log('[DB] Yerel SQLite veritabani basariyla baglandi (database.sqlite).');
} catch (err) {
  console.log('[DB Uyarisi] node:sqlite acilamadi, JSON yedek deposu kullanilacak:', err.message);
  useJsonFallback = true;
  if (!fs.existsSync(jsonDbPath)) {
    fs.writeFileSync(jsonDbPath, JSON.stringify({
      locations: [],
      geofences: [],
      shift_settings: { activeDays: [1,2,3,4,5], startTime: '08:30', endTime: '18:00', blockOffShift: 1 }
    }, null, 2));
  }
}

// Haversine ile iki koordinat arasi mesafe (Metre cinsinden)
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// Konum Kaydet
function saveLocation(userId, latitude, longitude, speed = 0, battery = 100, timestamp = null) {
  const ts = timestamp || new Date().toISOString();
  const lat = Number(latitude);
  const lon = Number(longitude);
  const spd = Number(speed) || 0;
  const bat = Number(battery) || 100;

  if (db && !useJsonFallback) {
    const stmt = db.prepare(`
      INSERT INTO locations (userId, latitude, longitude, speed, battery, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(userId, lat, lon, spd, bat, ts);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      data.locations.push({ userId, latitude: lat, longitude: lon, speed: spd, battery: bat, timestamp: ts });
      if (data.locations.length > 5000) data.locations.shift();
      fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }
}

// Her personelin en son konumunu getir
function getLatestLocations() {
  if (db && !useJsonFallback) {
    const query = `
      SELECT l.*
      FROM locations l
      INNER JOIN (
        SELECT userId, MAX(id) as max_id
        FROM locations
        GROUP BY userId
      ) latest ON l.id = latest.max_id
    `;
    return db.prepare(query).all();
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      const map = {};
      data.locations.forEach((loc) => {
        map[loc.userId] = loc;
      });
      return Object.values(map);
    } catch (e) {
      return [];
    }
  }
}

// Personelin gecmis rota noktalarini getir (Zaman sirali, opsiyonel tarih filtreli)
function getHistory(userId, limit = 500, date = null) {
  if (db && !useJsonFallback) {
    if (date) {
      const stmt = db.prepare(`
        SELECT latitude, longitude, speed, battery, timestamp
        FROM locations
        WHERE userId = ? AND timestamp LIKE ?
        ORDER BY id ASC
        LIMIT ?
      `);
      return stmt.all(userId, `${date}%`, limit);
    } else {
      const stmt = db.prepare(`
        SELECT latitude, longitude, speed, battery, timestamp
        FROM locations
        WHERE userId = ?
        ORDER BY id ASC
        LIMIT ?
      `);
      return stmt.all(userId, limit);
    }
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      return data.locations
        .filter((l) => l.userId === userId && (!date || (l.timestamp && l.timestamp.startsWith(date))))
        .slice(-limit);
    } catch (e) {
      return [];
    }
  }
}

// Gunluk Ozet (Tarih filtreli)
function getDailySummary(userId, date = null) {
  const history = getHistory(userId, 3000, date);
  if (!history || history.length === 0) {
    return { totalKm: '0.00', pointsCount: 0, maxSpeed: 0, startTime: null, endTime: null };
  }

  let totalMeters = 0;
  let maxSpeed = 0;

  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    const dist = calculateDistanceMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
    if (dist < 1000) {
      totalMeters += dist;
    }
    if (curr.speed > maxSpeed) {
      maxSpeed = curr.speed;
    }
  }

  return {
    totalKm: (totalMeters / 1000).toFixed(2),
    pointsCount: history.length,
    maxSpeed: Math.round(maxSpeed),
    startTime: history[0].timestamp,
    endTime: history[history.length - 1].timestamp
  };
}

// Mesai Ayarlari
function getShiftSettings() {
  if (db && !useJsonFallback) {
    const row = db.prepare('SELECT * FROM shift_settings WHERE id = 1').all()[0];
    if (row) {
      return {
        activeDays: JSON.parse(row.activeDays),
        startTime: row.startTime,
        endTime: row.endTime,
        blockOffShift: Boolean(row.blockOffShift)
      };
    }
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      return data.shift_settings || { activeDays: [1,2,3,4,5], startTime: '08:30', endTime: '18:00', blockOffShift: true };
    } catch (e) {}
  }
  return { activeDays: [1,2,3,4,5], startTime: '08:30', endTime: '18:00', blockOffShift: true };
}

function saveShiftSettings(activeDays, startTime, endTime, blockOffShift) {
  const daysJson = JSON.stringify(activeDays);
  const blockInt = blockOffShift ? 1 : 0;

  if (db && !useJsonFallback) {
    db.prepare(`
      INSERT OR REPLACE INTO shift_settings (id, activeDays, startTime, endTime, blockOffShift)
      VALUES (1, ?, ?, ?, ?)
    `).run(daysJson, startTime, endTime, blockInt);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      data.shift_settings = { activeDays, startTime, endTime, blockOffShift: Boolean(blockOffShift) };
      fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }
  return getShiftSettings();
}

// Su an mesai saatleri icinde miyiz kontrolu
function isWithinShift() {
  const s = getShiftSettings();
  if (!s.blockOffShift) {
    return { inShift: true };
  }

  const now = new Date();
  const day = now.getDay(); // 0: Pazar, 1: Pazartesi, ..., 6: Cumartesi
  const dayNames = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

  // Hafta sonu / İzin günü kontrolü
  if (!s.activeDays.includes(day)) {
    return { inShift: false, reason: `Bugün (${dayNames[day]}) izinli gün. Mesai dışı takip kapalı.` };
  }

  // Saat aralığı kontrolü
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = s.startTime.split(':').map(Number);
  const [endH, endM] = s.endTime.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
    return { inShift: false, reason: `Mesai saatleri dışı (${s.startTime} - ${s.endTime}). Takip durduruldu.` };
  }

  return { inShift: true };
}

// Coğrafi Çitler (Geofences)
function getGeofences() {
  if (db && !useJsonFallback) {
    return db.prepare('SELECT * FROM geofences ORDER BY id DESC').all();
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      return data.geofences || [];
    } catch (e) {
      return [];
    }
  }
}

function addGeofence(name, latitude, longitude, radius) {
  if (db && !useJsonFallback) {
    const stmt = db.prepare('INSERT INTO geofences (name, latitude, longitude, radius) VALUES (?, ?, ?, ?)');
    stmt.run(name, Number(latitude), Number(longitude), Number(radius));
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      data.geofences = data.geofences || [];
      data.geofences.push({ id: Date.now(), name, latitude: Number(latitude), longitude: Number(longitude), radius: Number(radius) });
      fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }
  return getGeofences();
}

function deleteGeofence(id) {
  if (db && !useJsonFallback) {
    db.prepare('DELETE FROM geofences WHERE id = ?').run(id);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      data.geofences = (data.geofences || []).filter((g) => g.id != id);
      fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }
  return getGeofences();
}

// 8. Müşteri & Şantiye Noktaları (POI)
function getCustomers() {
  if (db && !useJsonFallback) {
    return db.prepare('SELECT * FROM customers ORDER BY id DESC').all();
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      return data.customers || [];
    } catch (e) {
      return [];
    }
  }
}

function addCustomer(name, address, latitude, longitude, radius = 150) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  const rad = Number(radius) || 150;

  if (db && !useJsonFallback) {
    const stmt = db.prepare('INSERT INTO customers (name, address, latitude, longitude, radius) VALUES (?, ?, ?, ?, ?)');
    stmt.run(name, address || '', lat, lon, rad);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      data.customers = data.customers || [];
      data.customers.push({ id: Date.now(), name, address: address || '', latitude: lat, longitude: lon, radius: rad });
      fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }
  return getCustomers();
}

function deleteCustomer(id) {
  if (db && !useJsonFallback) {
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      data.customers = (data.customers || []).filter((c) => c.id != id);
      fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }
  return getCustomers();
}

// 9. Fotoğraflı Saha Raporları
function saveFieldReport(userId, photo, note = '', latitude, longitude, timestamp = null) {
  const ts = timestamp || new Date().toISOString();
  const lat = Number(latitude);
  const lon = Number(longitude);

  if (db && !useJsonFallback) {
    const stmt = db.prepare(`
      INSERT INTO field_reports (userId, photo, note, latitude, longitude, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(userId, photo, note, lat, lon, ts);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      data.field_reports = data.field_reports || [];
      data.field_reports.push({ id: Date.now(), userId, photo, note, latitude: lat, longitude: lon, timestamp: ts });
      if (data.field_reports.length > 500) data.field_reports.shift();
      fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }
}

function getFieldReports(limit = 100) {
  if (db && !useJsonFallback) {
    return db.prepare('SELECT * FROM field_reports ORDER BY id DESC LIMIT ?').all(limit);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      return (data.field_reports || []).slice(-limit).reverse();
    } catch (e) {
      return [];
    }
  }
}

// 10. Otomatik Müşteri Ziyaret Kayıtları (Check-in / Check-out)
function recordVisit(customerId, customerName, userId, entryTime, exitTime, durationMinutes, date = null) {
  const d = date || new Date().toISOString().slice(0, 10);
  if (db && !useJsonFallback) {
    const stmt = db.prepare(`
      INSERT INTO customer_visits (customerId, customerName, userId, entryTime, exitTime, durationMinutes, date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(customerId, customerName, userId, entryTime, exitTime, durationMinutes, d);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      data.customer_visits = data.customer_visits || [];
      data.customer_visits.push({ id: Date.now(), customerId, customerName, userId, entryTime, exitTime, durationMinutes, date: d });
      fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }
}

function getVisits(date = null, userId = null) {
  if (db && !useJsonFallback) {
    let sql = 'SELECT * FROM customer_visits WHERE 1=1';
    const params = [];
    if (date) { sql += ' AND date = ?'; params.push(date); }
    if (userId) { sql += ' AND userId = ?'; params.push(userId); }
    sql += ' ORDER BY id DESC LIMIT 200';
    return db.prepare(sql).all(...params);
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
      return (data.customer_visits || []).filter(v => (!date || v.date === date) && (!userId || v.userId === userId));
    } catch (e) {
      return [];
    }
  }
}

module.exports = {
  saveLocation,
  getLatestLocations,
  getHistory,
  getDailySummary,
  getShiftSettings,
  saveShiftSettings,
  isWithinShift,
  getGeofences,
  addGeofence,
  deleteGeofence,
  calculateDistanceMeters,
  getCustomers,
  addCustomer,
  deleteCustomer,
  saveFieldReport,
  getFieldReports,
  recordVisit,
  getVisits
};
