# ASCII-only launcher (Windows PowerShell 5.1 parses .ps1 as ANSI without a BOM).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
#   powershell -ExecutionPolicy Bypass -File .\start.ps1 -Restart
#   powershell -ExecutionPolicy Bypass -File .\start.ps1 -Restart -Port 8899 -NoBrowser

param(
  [switch]$Restart,
  [int]$Port = 8787,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Prefer whatever `node` is on PATH; only fall back to a hardcoded path if you
# actually need one (edit the line below for your own machine).
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }

if (-not $node -or -not (Test-Path $node)) {
  Write-Host '[XX] node.exe not found. Install Node.js or edit $node in this script.' -ForegroundColor Red
  exit 1
}

function Get-PortOwner([int]$p) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
          Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

$owner = Get-PortOwner $Port
if ($owner) {
  if (-not $Restart) {
    Write-Host "[!!] Port $Port already in use by PID $owner -- console probably already running." -ForegroundColor Yellow
    Write-Host "     Open http://127.0.0.1:$Port  (or pass -Restart to force restart)" -ForegroundColor Yellow
    exit 0
  }
  Write-Host "[->] Stopping old process $owner ..." -ForegroundColor Cyan
  Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 900
}

$logDir = Join-Path $here 'data'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir 'server.log'
$errLog = Join-Path $logDir 'server.err.log'

# Detach via WMI: the console must outlive this script and this shell.
# (Start-Process + pipeline keeps inherited handles open and hangs the caller.)
$cmdLine = 'cmd.exe /c "set PORT={0}&& "{1}" server.mjs > "{2}" 2> "{3}""' -f $Port, $node, $outLog, $errLog
Write-Host '[->] Starting console ...' -ForegroundColor Cyan
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $cmdLine
  CurrentDirectory = $here
}
if ($res.ReturnValue -ne 0) {
  Write-Host "[XX] Failed to spawn process (ReturnValue=$($res.ReturnValue))" -ForegroundColor Red
  exit 1
}

# Wait until the HTTP port actually answers
$url = "http://127.0.0.1:$Port"
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $null = Invoke-RestMethod "$url/api/state" -TimeoutSec 3
    $ok = $true
    break
  } catch { }
}

if ($ok) {
  Write-Host "[OK] Console is up: $url" -ForegroundColor Green
  Write-Host "     Spawner PID : $($res.ProcessId)" -ForegroundColor DarkGray
  Write-Host "     Console log : $outLog" -ForegroundColor DarkGray
  Write-Host "     Stop with   : Get-NetTCPConnection -LocalPort $Port -State Listen | ForEach-Object { Stop-Process -Id `$_.OwningProcess -Force }" -ForegroundColor DarkGray
  if (-not $NoBrowser) { Start-Process $url }
} else {
  Write-Host '[XX] Started but the port never answered. Last log lines:' -ForegroundColor Red
  if (Test-Path $outLog) { Get-Content $outLog -Tail 20 -Encoding UTF8 }
  if (Test-Path $errLog) { Get-Content $errLog -Tail 20 -Encoding UTF8 }
  exit 1
}
