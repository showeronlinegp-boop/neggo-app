# Registra la tarea programada "Neggo resumen prospectos": todos los días a las 21:30 abre Claude
# Code con la skill resumen-prospectos (resumen-prospectos.ps1). Si la PC estaba apagada o
# suspendida a esa hora, corre apenas se pueda.
#   powershell -ExecutionPolicy Bypass -File tools\claude-link\registrar-resumen.ps1
# Para sacarla: Unregister-ScheduledTask -TaskName 'Neggo resumen prospectos' -Confirm:$false

param([string]$Hora = '21:30')

$nombre = 'Neggo resumen prospectos'
$script = Join-Path $PSScriptRoot 'resumen-prospectos.ps1'
$accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$cuando = New-ScheduledTaskTrigger -Daily -At $Hora
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $cuando -Settings $config -Force | Out-Null
Write-Output "Tarea '$nombre' registrada: todos los días a las $Hora ($script)"
