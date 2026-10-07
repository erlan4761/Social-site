<#
  Открывает локально запущенный Duet в интернет через бесплатный туннель
  Cloudflare: сервер работает на этом компьютере, а наружу смотрит адрес вида
  https://что-то-случайное.trycloudflare.com. Сайт доступен, пока открыто это
  окно; адрес новый при каждом запуске. Ctrl+C останавливает и сервер, и туннель.

  Запуск из корня репозитория:
    powershell -ExecutionPolicy Bypass -File scripts\share.ps1
#>
param(
  [string]$Cloudflared = "$env:USERPROFILE\tools\cloudflared.exe",
  # Отдельно от server\data: там локальная разработка, а сюда пишут живые
  # люди — смешивать тестовые аккаунты с настоящими незачем.
  # Пусто — %USERPROFILE%\duet-data (или прежняя hronika-data, см. ниже).
  [string]$DataDir = '',
  [int]$Port = 3001,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

if (-not $DataDir) {
  $DataDir = "$env:USERPROFILE\duet-data"
  # До переименования данные жили в hronika-data: новой папки нет, а старая
  # есть — берём старую, иначе живые аккаунты «пропали» бы после обновления.
  $legacy = "$env:USERPROFILE\hronika-data"
  if (-not (Test-Path $DataDir) -and (Test-Path $legacy)) { $DataDir = $legacy }
}

if (-not (Test-Path $Cloudflared)) {
  $onPath = Get-Command cloudflared -ErrorAction SilentlyContinue
  if (-not $onPath) { throw "Не найден cloudflared: ни $Cloudflared, ни в PATH" }
  $Cloudflared = $onPath.Source
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Порт $Port уже занят — сервер уже запущен или порт нужен другой программе (-Port)"
}

if (-not $SkipBuild) {
  Write-Host 'Собираю фронтенд…'
  Push-Location "$root\web"
  try {
    npm run build | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Сборка фронтенда не удалась — запустите npm run build в web и посмотрите ошибку' }
  } finally { Pop-Location }
}

$logDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$tunnelLog = Join-Path $logDir 'tunnel.log'
Remove-Item $tunnelLog -ErrorAction SilentlyContinue

$tunnel = $null
$server = $null
try {
  Write-Host 'Поднимаю туннель…'
  $tunnel = Start-Process -FilePath $Cloudflared -PassThru -WindowStyle Hidden `
    -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$Port" `
    -RedirectStandardError $tunnelLog -RedirectStandardOutput (Join-Path $logDir 'tunnel.out.log')

  # Адрес туннеля cloudflared печатает в свой лог через несколько секунд.
  $url = $null
  foreach ($i in 1..60) {
    Start-Sleep -Seconds 1
    if ($tunnel.HasExited) { throw "cloudflared завершился, лог: $tunnelLog" }
    $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
  if (-not $url) { throw "Туннель не выдал адрес за минуту, лог: $tunnelLog" }

  # Боевой режим: кука сессии secure (туннель отдаёт сайт по HTTPS), полные
  # лимиты на вход и рассылку. Тестовые переменные, если остались в окружении
  # этой консоли, снимаются — иначе защита от перебора была бы ослаблена.
  $env:NODE_ENV = 'production'
  $env:PORT = "$Port"
  $env:DATA_DIR = $DataDir
  # Ссылка в письме сброса пароля должна вести на адрес туннеля, а не на localhost.
  $env:PUBLIC_URL = $url
  Remove-Item Env:RELAX_RATE_LIMITS, Env:DB_PATH -ErrorAction SilentlyContinue

  $server = Start-Process -FilePath node -ArgumentList 'server/src/index.js' `
    -WorkingDirectory $root -NoNewWindow -PassThru

  Write-Host ''
  Write-Host "  Duet открыт в интернете: $url" -ForegroundColor Green
  Write-Host "  Данные: $DataDir"
  Write-Host '  Остановить — Ctrl+C. Письма сброса пароля печатаются ниже.'
  Write-Host ''

  while (-not $server.HasExited -and -not $tunnel.HasExited) { Start-Sleep -Seconds 1 }
  if ($tunnel.HasExited) { Write-Warning "Туннель оборвался, лог: $tunnelLog" }
  if ($server.HasExited) { Write-Warning 'Сервер остановился — причина выше' }
} finally {
  foreach ($p in @($server, $tunnel)) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
}
