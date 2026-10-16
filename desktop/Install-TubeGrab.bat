@echo off
title Install TubeGrab
cd /d "%~dp0\.."
echo Installing TubeGrab Desktop and Start Menu shortcuts...
cscript //nologo tools\create-shortcut.vbs
echo.
echo [OK] Done! TubeGrab is now installed on your system with official app icons.
timeout /t 3
