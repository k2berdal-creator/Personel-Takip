@echo off
title Expo Mobil Istemci
echo ==============================================
echo       Expo Mobil Sunucusu Baslatiliyor
echo ==============================================
cd /d "%~dp0client-app"
npx expo start
pause

