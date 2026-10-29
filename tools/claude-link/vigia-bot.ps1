# Vigia de tareas del bot: cada 30 segundos le pregunta al backend (docker exec, sin pasar por la
# red) si el bot pidio ejecutar una tarea (POST /api/agente/notas/{id}/ejecutar) y, si hay una,
# abre Claude Code con abrir-nota.ps1, el mismo lanzador del boton "Enviar a Claude".
# De a una: el backend no entrega otra hasta que Claude conteste la que esta abierta.
#
# SEGURIDAD: del backend solo se acepta un numero y el pedido a Claude es fijo (abrir-nota.ps1).
# Se registra para que arranque con la sesion de Windows con registrar-vigia.ps1; para frenarlo,
# desregistrar-vigia.ps1. Log en %TEMP%\neggo-vigia-bot.log

param([int]$Segundos = 30)

$log = Join-Path $env:TEMP 'neggo-vigia-bot.log'
function Log($msg) { Add-Content -Path $log -Value "$(Get-Date -Format s)  $msg" -Encoding UTF8 }

# Una sola copia corriendo
$mutex = New-Object System.Threading.Mutex($false, 'Local\NeggoVigiaBot')
if (-not $mutex.WaitOne(0)) {
    Log 'Ya hay un vigia corriendo'
    exit 0
}

$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$abrir = Join-Path $PSScriptRoot 'abrir-nota.ps1'
if (-not (Test-Path $docker) -or -not (Test-Path $abrir)) {
    Log "Falta docker.exe o abrir-nota.ps1"
    exit 1
}
Log "Vigia iniciado (cada $Segundos s)"

while ($true) {
    try {
        $contenedor = & $docker ps -q --filter 'label=com.docker.compose.project=neggo-app' --filter 'label=com.docker.compose.service=backend' 2>$null |
            Select-Object -First 1
        if ($contenedor) {
            $salida = & $docker exec $contenedor node scripts/notaPrueba.js bot-siguiente 2>$null
            $ultima = $salida | Where-Object { $_ -match '\S' } | Select-Object -Last 1
            if ($ultima -match '^\s*(\d{1,9})\s*$') {
                $id = [int]$Matches[1]
                Log "Tarea del bot #${id}: abriendo Claude"
                & $abrir -Url "neggo-claude://nota/$id"
            }
        }
    } catch {
        Log "Error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $Segundos
}
