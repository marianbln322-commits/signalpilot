@echo off
setlocal
cd /d "%~dp0"
title SignalPilot - localhost:3010

echo ====================================================
echo   SIGNALPILOT - PORNIRE AUTOMATA PE PORTUL 3010
echo ====================================================
echo.
echo La prima pornire poate dura cateva minute:
echo runtime-ul si dependentele se instaleaza automat local.
echo Browserul se va deschide singur la http://localhost:3010
echo Pentru oprire, inchide aceasta fereastra.
echo.

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo EROARE: Windows PowerShell nu este disponibil.
  echo Porneste aplicatia pe un sistem Windows 10 sau 11.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
set "SIGNALPILOT_EXIT=%ERRORLEVEL%"

if not "%SIGNALPILOT_EXIT%"=="0" (
  echo.
  echo SignalPilot nu a putut porni. Cod eroare: %SIGNALPILOT_EXIT%
  echo Verifica mesajul de mai sus si conexiunea la internet.
  pause
)

endlocal & exit /b %SIGNALPILOT_EXIT%
