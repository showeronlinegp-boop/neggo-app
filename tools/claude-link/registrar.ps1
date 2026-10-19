# Registra el link neggo-claude:// para el usuario actual de Windows (sin permisos de administrador).
# Windows lo abre con abrir-nota.ps1, que solo acepta nota/<numero> y rechaza todo lo demas.
#
#   powershell -ExecutionPolicy Bypass -File tools\claude-link\registrar.ps1
#
# Se puede correr las veces que quieras: vuelve a apuntar el link a la copia de abrir-nota.ps1
# que esta al lado de este script. Para sacarlo: desregistrar.ps1.

$script = Join-Path $PSScriptRoot 'abrir-nota.ps1'
if (-not (Test-Path $script)) {
    Write-Host "No encuentro $script"
    exit 1
}

$base = 'HKCU:\Software\Classes\neggo-claude'
$comando = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" `"%1`""

New-Item -Path $base -Force | Out-Null
Set-ItemProperty -Path $base -Name '(default)' -Value 'URL:Neggo Claude (notas de prueba)'
Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''
New-Item -Path "$base\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$base\shell\open\command" -Name '(default)' -Value $comando

Write-Host "Link neggo-claude:// registrado"
Write-Host "Abre: $script"
