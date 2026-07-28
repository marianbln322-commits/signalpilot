$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$env:PORT = '3010'

function Test-NodeRuntime {
  param([string]$NodePath)
  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) { return $false }
  try {
    $major = [int]((& $NodePath -p "process.versions.node.split('.')[0]").Trim())
    return $major -ge 18
  } catch {
    return $false
  }
}

function Find-SystemNode {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command -and (Test-NodeRuntime $command.Source)) { return $command.Source }
  return $null
}

function Find-PortableNode {
  $runtimeRoot = Join-Path $projectRoot '.runtime'
  if (-not (Test-Path -LiteralPath $runtimeRoot)) { return $null }
  $candidate = Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'node-v*-win-*' } |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName 'node.exe' } |
    Where-Object { Test-NodeRuntime $_ } |
    Select-Object -First 1
  return $candidate
}

function Install-PortableNode {
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  if ($architecture -notin @('x64', 'arm64')) {
    throw "Arhitectura Windows '$architecture' nu este suportata automat. Instaleaza Node.js 18+ manual."
  }

  $runtimeRoot = Join-Path $projectRoot '.runtime'
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $checksumsPath = Join-Path $runtimeRoot 'SHASUMS256.txt'
  $baseUrl = 'https://nodejs.org/dist/latest-v22.x'

  Write-Host 'Node.js nu este instalat. Descarc automat runtime-ul portabil oficial...' -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -OutFile $checksumsPath
  $pattern = "^([a-fA-F0-9]{64})\s+(node-v[0-9.]+-win-$architecture\.zip)$"
  $checksumLine = Get-Content $checksumsPath | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $checksumLine -or $checksumLine -notmatch $pattern) {
    throw 'Nu am putut identifica arhiva oficiala Node.js pentru acest PC.'
  }

  $expectedHash = $Matches[1].ToUpperInvariant()
  $archiveName = $Matches[2]
  $archivePath = Join-Path $runtimeRoot $archiveName
  $folderName = [System.IO.Path]::GetFileNameWithoutExtension($archiveName)
  $nodePath = Join-Path (Join-Path $runtimeRoot $folderName) 'node.exe'

  if (-not (Test-NodeRuntime $nodePath)) {
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $archivePath
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
      Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
      throw 'Verificarea de securitate SHA256 pentru Node.js a esuat.'
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
    Remove-Item -LiteralPath @($archivePath, $checksumsPath) -Force -ErrorAction SilentlyContinue
  }

  if (-not (Test-NodeRuntime $nodePath)) {
    throw 'Runtime-ul Node.js portabil nu a putut fi pregatit.'
  }
  return $nodePath
}

try {
  $nodePath = Find-SystemNode
  if (-not $nodePath) { $nodePath = Find-PortableNode }
  if (-not $nodePath) { $nodePath = Install-PortableNode }

  $nodeDirectory = Split-Path -Parent $nodePath
  $env:PATH = "$nodeDirectory;$env:PATH"
  $npmPath = Join-Path $nodeDirectory 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npmPath)) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) { throw 'npm nu este disponibil in runtime-ul Node.js.' }
    $npmPath = $npmCommand.Source
  }

  $lockPath = Join-Path $projectRoot 'package-lock.json'
  $markerPath = Join-Path $projectRoot 'node_modules\.signalpilot-lock-hash'
  $lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $lockPath).Hash
  $installedHash = if (Test-Path -LiteralPath $markerPath) { (Get-Content -LiteralPath $markerPath -Raw).Trim() } else { '' }
  if ($installedHash -ne $lockHash) {
    Write-Host 'Prima pornire sau actualizare: instalez dependentele aplicatiei...' -ForegroundColor Cyan
    & $npmPath ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Instalarea dependentelor a esuat cu codul $LASTEXITCODE." }
    Set-Content -LiteralPath $markerPath -Value $lockHash -NoNewline
  }

  Write-Host ''
  Write-Host 'Pornesc SignalPilot la http://localhost:3010 ...' -ForegroundColor Green
  $serverPath = Join-Path $projectRoot 'server.js'
  $serverProcess = Start-Process -FilePath $nodePath -ArgumentList @("`"$serverPath`"") -WorkingDirectory $projectRoot -NoNewWindow -PassThru
  try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      if ($serverProcess.HasExited) {
        throw "Serverul SignalPilot s-a oprit cu codul $($serverProcess.ExitCode)."
      }
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3010/api/state' -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
          $ready = $true
          break
        }
      } catch {
        Start-Sleep -Milliseconds 500
      }
    }
    if (-not $ready) {
      throw 'Serverul nu a devenit disponibil la localhost:3010 in timpul asteptat.'
    }

    Start-Process 'http://localhost:3010'
    Write-Host 'SignalPilot ruleaza. Inchide aceasta fereastra pentru oprire.' -ForegroundColor Green
    Wait-Process -Id $serverProcess.Id
    $serverProcess.Refresh()
    exit $serverProcess.ExitCode
  } finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
      Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
} catch {
  Write-Host ''
  Write-Host "EROARE: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
