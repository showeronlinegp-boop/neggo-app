# Registra el vigia de tareas del bot (vigia-bot.ps1) como tarea programada del usuario actual:
# arranca al iniciar sesion en Windows, oculto, y queda corriendo; si se corta, vuelve solo en
# menos de 5 minutos. Sin permisos de administrador.
#
#   powershell -ExecutionPolicy Bypass -File tools\claude-link\registrar-vigia.ps1
#
# Necesita el link neggo-claude:// registrado antes (registrar.ps1) solo para el boton de la app;
# el vigia llama directo a abrir-nota.ps1. Para sacarlo: desregistrar-vigia.ps1.

$script = Join-Path $PSScriptRoot 'vigia-bot.ps1'
if (-not (Test-Path $script)) {
    Write-Host "No encuentro $script"
    exit 1
}

$nombre = 'Neggo vigia bot'
$accion = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$alIniciar = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Cada 5 minutos lo vuelve a lanzar por si se corto (suspension, cierre del proceso). Si ya esta
# corriendo, la tarea ignora el disparo (IgnoreNew) y el mutex del vigia corta cualquier copia.
$cada5 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger @($alIniciar, $cada5) -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $nombre

Write-Host "Vigia registrado y corriendo ($nombre)"
Write-Host "Log: $(Join-Path $env:TEMP 'neggo-vigia-bot.log')"
