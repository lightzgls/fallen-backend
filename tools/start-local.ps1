[CmdletBinding()]
param(
  [switch]$Mobile,
  [string]$Serial,
  [ValidateRange(1, 3600)]
  [int]$StartupTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$adminEnvFile = Join-Path $repoRoot 'admin-web\.env.local'
$adminEnvExample = Join-Path $repoRoot 'admin-web\.env.example'
$mobileScript = Join-Path (Split-Path -Parent $repoRoot) 'fallen-mobile\tools\start-firebase-emulator.ps1'

function Test-LocalPort {
  param([int]$Port)

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $client.Connect([System.Net.IPAddress]::Loopback, $Port)
    return $true
  }
  catch [System.Net.Sockets.SocketException] {
    if ($_.Exception.SocketErrorCode -ne 'ConnectionRefused') { throw }
    return $false
  }
  finally {
    $client.Dispose()
  }
}

function Assert-LocalPortAvailable {
  param([int]$Port)

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try {
    $listener.ExclusiveAddressUse = $true
    $listener.Start()
  }
  catch [System.Net.Sockets.SocketException] {
    if ($_.Exception.SocketErrorCode -eq 'AddressAlreadyInUse') {
      throw "Cong 127.0.0.1:${Port} dang duoc su dung. Hay dung tien trinh dang giu cong truoc khi khoi dong phien moi."
    }
    throw "Khong the mo cong 127.0.0.1:${Port} ($($_.Exception.SocketErrorCode)). $($_.Exception.Message)"
  }
  finally {
    $listener.Stop()
  }
}

$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
if (-not $npm) {
  throw 'Khong tim thay npm. Hay cai Node.js 22 va npm truoc khi chay.'
}

foreach ($binary in @('firebase.cmd', 'tsc.cmd', 'vite.cmd')) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules\.bin\$binary") -PathType Leaf)) {
    throw 'Chua co dependencies. Hay chay "npm ci" tai thu muc fallEN.'
  }
}

if ($Mobile -and -not (Test-Path -LiteralPath $mobileScript -PathType Leaf)) {
  throw "Khong tim thay script Android: $mobileScript"
}

$firebaseConfig = Get-Content -LiteralPath (Join-Path $repoRoot 'firebase.json') -Raw | ConvertFrom-Json
$adminPort = 5173
$emulatorPorts = $firebaseConfig.emulators.PSObject.Properties |
  ForEach-Object { $_.Value } |
  Where-Object { $_.port -and $_.enabled -ne $false } |
  ForEach-Object { [int]$_.port }
$ports = @($adminPort) + @($emulatorPorts)

foreach ($port in $ports) {
  Assert-LocalPortAvailable -Port $port
}

if (-not (Test-Path -LiteralPath $adminEnvFile)) {
  Copy-Item -LiteralPath $adminEnvExample -Destination $adminEnvFile
  Write-Host 'Da tao admin-web/.env.local tu cau hinh emulator mau.' -ForegroundColor Yellow
}

. (Join-Path $PSScriptRoot 'emulator-env.ps1')
if (-not (Get-Command java.exe -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'Khong tim thay Java. Hay cai Java 21 tro len va kiem tra JAVA_HOME.'
}

$processes = [ordered]@{}

try {
  Write-Host 'Dang khoi dong Firebase backend va admin web...' -ForegroundColor Cyan
  Write-Host 'Nhan Ctrl+C de dung ca hai.' -ForegroundColor DarkGray

  $processes['Firebase'] = Start-Process -FilePath $npm.Source `
    -ArgumentList @('run', 'emulators') `
    -WorkingDirectory $repoRoot `
    -NoNewWindow `
    -PassThru

  $processes['Admin web'] = Start-Process -FilePath $npm.Source `
    -ArgumentList @('run', 'dev') `
    -WorkingDirectory $repoRoot `
    -NoNewWindow `
    -PassThru

  $startup = [System.Diagnostics.Stopwatch]::StartNew()
  $ready = $false
  while ($true) {
    foreach ($name in $processes.Keys) {
      $process = $processes[$name]
      if ($process.HasExited) {
        throw "$name da dung (exit code $($process.ExitCode)). Xem log phia tren."
      }
    }

    if (-not $ready) {
      $pendingPorts = @($ports | Where-Object { -not (Test-LocalPort -Port $_) })
      if ($pendingPorts.Count -eq 0) {
        $ready = $true
        Write-Host 'Server local da san sang.' -ForegroundColor Green
        Write-Host "Admin:       http://127.0.0.1:$adminPort"
        if ($firebaseConfig.emulators.ui.enabled) {
          Write-Host "Emulator UI: http://127.0.0.1:$($firebaseConfig.emulators.ui.port)"
        }
        if ($Mobile) {
          & $mobileScript -ConnectOnly -Serial $Serial
        }
      }
      elseif ($startup.Elapsed.TotalSeconds -ge $StartupTimeoutSeconds) {
        throw "Het thoi gian khoi dong. Cac cong chua san sang: $($pendingPorts -join ', '). Xem log phia tren."
      }
    }
    Start-Sleep -Milliseconds 500
  }
}
finally {
  Write-Host "`nDang dung backend va admin web..." -ForegroundColor Yellow
  foreach ($process in $processes.Values) {
    if (-not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    }
  }
}
