# Registra el vigia de tareas del bot (vigia-bot.ps1) como tarea programada del usuario actual:
# arranca al iniciar sesion en Windows, oculto, y queda corriendo. Sin permisos de administrador.
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
$disparo = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparo -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $nombre

Write-Host "Vigia registrado y corriendo ($nombre)"
Write-Host "Log: $(Join-Path $env:TEMP 'neggo-vigia-bot.log')"
