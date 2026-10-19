# Saca el link neggo-claude:// registrado por registrar.ps1.
#
#   powershell -ExecutionPolicy Bypass -File tools\claude-link\desregistrar.ps1

$base = 'HKCU:\Software\Classes\neggo-claude'
if (Test-Path $base) {
    Remove-Item -Path $base -Recurse -Force
    Write-Host "Link neggo-claude:// eliminado"
} else {
    Write-Host "El link neggo-claude:// no estaba registrado"
}
