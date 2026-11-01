@echo off
title Personel Takip Sistemi - Ana Yonetici
color 0A
echo ==============================================================
echo             PERSONEL TAKIP SISTEMI BASLATILIYOR
echo ==============================================================
echo.

:: 1. Eski asili surecleri temizle
echo [*] Eski arka plan surecleri temizleniyor...
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1

:: 2. Backend Sunucusunu Baslat (Port 5005)
echo [1/3] Backend Sunucusu baslatiliyor (Port 5005)...
start "1. Backend (API & Soket)" /d "%~dp0backend" cmd /k node server.js
timeout /t 2 /nobreak >nul

:: 3. Admin Panelini Baslat (Port 5173)
echo [2/3] Admin Paneli baslatiliyor (Port 5173)...
start "2. Admin Paneli (Vite)" /d "%~dp0admin-panel" cmd /k npm run dev
timeout /t 2 /nobreak >nul

:: 4. Cloudflare Internet Tunelini Baslat (Saha personeli icin)
echo [3/3] Saha Personeli Icin Internet Tuneli Aciliyor...
start "3. Saha Internet Tuneli (Cloudflare)" cmd /k npx cloudflared tunnel --url http://127.0.0.1:5005
timeout /t 3 /nobreak >nul

:: 5. Tarayiciyi Ac
echo [*] Harita paneli tarayicida aciliyor...
start http://localhost:5173

echo.
echo ==============================================================
echo               SISTEM BASARIYLA AYAGA KALKTI!
echo ==============================================================
echo  1. Yonetim Haritasi:   http://localhost:5173 (Tarayicida acildi)
echo  2. Saha Tunel Linki:   Acilan 3. siyah penceredeki linktir
echo                         (https://....trycloudflare.com)
echo.
echo  Sistemi tamamen kapatmak icin 'Sistemi Durdur.bat' calistirabilir
echo  veya bu pencereye herhangi bir tusa basabilirsiniz.
echo ==============================================================
pause

:: Kullanici tusa basarsa tum sistemi temiz kapat
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
echo Sistem kapatildi.
timeout /t 2 /nobreak >nul
