@echo off
title SignalPilot
echo ====================================================
echo   SignalPilot - se porneste, asteapta putin
echo ====================================================
echo.
echo Pornesc SignalPilot... se deschide singur in browser.
echo Ca sa opresti aplicatia: inchide aceasta fereastra.
echo.
if not exist node_modules (
  echo Prima pornire: instalez dependintele...
  call npm install
)
call npm start
pause
