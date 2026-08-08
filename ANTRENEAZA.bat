@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo ============================================================
echo   SIGNALPILOT - colectare date + antrenare
echo ============================================================
echo.
echo   Ruleaza tot singur. Dureaza ~10 minute in total.
echo   NU inchide fereastra si NU apasa taste pana la final.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [EROARE] Node.js nu este instalat.
  echo   Descarca-l de la https://nodejs.org  ^(versiunea LTS^) si reia.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do echo   Node: %%v
echo.

if not exist "node_modules\" (
  echo   [1/6] Instalez dependintele ^(o singura data^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [EROARE] npm install a esuat. Verifica internetul.
    pause
    exit /b 1
  )
) else (
  echo   [1/6] Dependinte deja instalate - sar peste.
)
echo.

if not exist "rezultate\" mkdir rezultate

echo   [2/6] Descarc istoricul ETHUSDT ^(~1 minut^)...
if exist "data\ETHUSDT-5m-365d.json" (
  echo         deja descarcat - sar peste.
) else (
  node tools\collect.js --symbol ETHUSDT --days 365
  if errorlevel 1 goto :fail
)
echo.

echo   [3/6] Descarc istoricul BTCUSDT ^(~1 minut^)...
if exist "data\BTCUSDT-5m-365d.json" (
  echo         deja descarcat - sar peste.
) else (
  node tools\collect.js --symbol BTCUSDT --days 365
  if errorlevel 1 goto :fail
)
echo.

echo   [4/6] Antrenez ETHUSDT pe 10 minute ^(~5 minute^)...
node tools\train.js --file data\ETHUSDT-5m-365d.json --horizon 10 > rezultate\ETH-10min.txt 2>&1
if errorlevel 1 goto :fail
call :verdict "ETH 10 min" "rezultate\ETH-10min.txt"

echo   [5/6] Antrenez ETHUSDT pe 30 minute ^(~5 minute^)...
node tools\train.js --file data\ETHUSDT-5m-365d.json --horizon 30 > rezultate\ETH-30min.txt 2>&1
if errorlevel 1 goto :fail
call :verdict "ETH 30 min" "rezultate\ETH-30min.txt"

echo   [6/6] Antrenez BTCUSDT pe 10 si 30 minute ^(~10 minute^)...
node tools\train.js --file data\BTCUSDT-5m-365d.json --horizon 10 > rezultate\BTC-10min.txt 2>&1
if errorlevel 1 goto :fail
call :verdict "BTC 10 min" "rezultate\BTC-10min.txt"
node tools\train.js --file data\BTCUSDT-5m-365d.json --horizon 30 > rezultate\BTC-30min.txt 2>&1
if errorlevel 1 goto :fail
call :verdict "BTC 30 min" "rezultate\BTC-30min.txt"

echo.
echo ============================================================
echo   GATA
echo ============================================================
echo.
echo   Rezultatele sunt in folderul  rezultate\
echo     ETH-10min.txt   ETH-30min.txt
echo     BTC-10min.txt   BTC-30min.txt
echo.
echo   Deschide fisierele si trimite ce scrie in ele.
echo.
start "" "%cd%\rezultate"
pause
exit /b 0

:verdict
echo.
echo        --- %~1 ---
findstr /C:"esantioane out-of-sample" /C:"eșantioane out-of-sample" /C:"Brier" /C:"break-even" /C:"TRECE" /C:"NU trece" "%~2"
echo.
exit /b 0

:fail
echo.
echo   [EROARE] Ceva a esuat. Deruleaza mai sus si trimite textul.
echo.
pause
exit /b 1
