# Frena y saca el vigia de tareas del bot (lo que registro registrar-vigia.ps1).
# Los pedidos de ejecucion que haga el bot quedan guardados, pero nadie abre Claude.
#
#   powershell -ExecutionPolicy Bypass -File tools\claude-link\desregistrar-vigia.ps1

$nombre = 'Neggo vigia bot'
if (Get-ScheduledTask -TaskName $nombre -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $nombre
    Unregister-ScheduledTask -TaskName $nombre -Confirm:$false
    Write-Host "Vigia frenado y desregistrado"
} else {
    Write-Host "El vigia no estaba registrado"
}
