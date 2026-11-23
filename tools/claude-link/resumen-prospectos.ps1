# Resumen de prospectos de WhatsApp (CRM, 067): abre Windows Terminal con Claude Code corriendo la
# skill resumen-prospectos. Lo dispara cada noche la tarea programada "Neggo resumen prospectos"
# (registrar-resumen.ps1), antes de que la depuración semanal del WhatsApp del negocio borre los
# mensajes de más de 7 días.
#
# SEGURIDAD: no recibe parámetros: el pedido a Claude es fijo.
# Log en %TEMP%\neggo-resumen-prospectos.log

$log = Join-Path $env:TEMP 'neggo-resumen-prospectos.log'
function Log($msg) { Add-Content -Path $log -Value "$(Get-Date -Format s)  $msg" -Encoding UTF8 }

# Raiz del repo: este script vive en <repo>\tools\claude-link
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $repo '.claude\skills\resumen-prospectos\SKILL.md'))) {
    Log "No encuentro la skill resumen-prospectos en $repo"
    exit 1
}

$claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if (-not (Test-Path $claude)) {
    Log "No encuentro claude.exe en $claude"
    exit 1
}

# Si el backend no está corriendo no hay nada que resumir
$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$backend = & $docker ps -q --filter 'label=com.docker.compose.project=neggo-app' --filter 'label=com.docker.compose.service=backend' 2>$null | Select-Object -First 1
if (-not $backend) {
    Log 'El backend no está corriendo: no se resume'
    exit 1
}

# Pedido fijo. Sin punto y coma (wt.exe lo usa para separar comandos) y sin acentos.
$prompt = 'Resumen de prospectos de WhatsApp. Segui la skill resumen-prospectos hasta que no queden pendientes.'
$argumentos = "-w new new-tab --title `"Resumen prospectos`" -d `"$repo`" `"$claude`" `"$prompt`""
Log "Abriendo Claude para el resumen de prospectos en $repo"
Start-Process -FilePath 'wt.exe' -ArgumentList $argumentos
