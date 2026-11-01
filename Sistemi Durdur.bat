@echo off
title Personel Takip Sistemi Kapatiliyor
color 0C
echo ==============================================================
echo             PERSONEL TAKIP SISTEMI DURDURULUYOR
echo ==============================================================
echo.
echo [*] Backend, Admin Paneli ve Cloudflare tuneli kapatiliyor...
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
echo [OK] Tum sistem basariyla durduruldu.
timeout /t 2 /nobreak >nul
exit

