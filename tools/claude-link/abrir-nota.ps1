# Abre Windows Terminal con Claude Code trabajando una nota de prueba. Lo ejecuta Windows cuando
# la app abre un link neggo-claude://nota/<id> (botón "Enviar a Claude"), registrado por registrar.ps1.
#
# SEGURIDAD: cualquier pagina abierta en el navegador podria intentar abrir un link
# neggo-claude://. Por eso aca SOLO se acepta "nota/" + un numero: el pedido a Claude es fijo y
# nunca se arma con texto que venga del link. Cualquier otra cosa se rechaza y queda en el log.
# El contenido de la nota lo lee Claude de la base con scripts/notaPrueba.js ver <id>.

param([string]$Url)

$log = Join-Path $env:TEMP 'neggo-claude-link.log'
function Log($msg) { Add-Content -Path $log -Value "$(Get-Date -Format s)  $msg" -Encoding UTF8 }

if ($Url -notmatch '^neggo-claude://nota/(\d{1,9})/?$') {
    Log "Link rechazado: '$Url'"
    exit 1
}
$id = [int]$Matches[1]

# Raiz del repo: este script vive en <repo>\tools\claude-link
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $repo 'backend'))) {
    Log "No encuentro el repo en $repo"
    exit 1
}

$claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if (-not (Test-Path $claude)) {
    Log "No encuentro claude.exe en $claude"
    exit 1
}

# Pedido fijo, solo con el numero. Sin punto y coma (wt.exe lo usa para separar comandos)
# y sin acentos (pasan mal por la linea de comandos de wt).
$titulo = "Nota #$id"
$prompt = "Nota de prueba #$id. Trabajala siguiendo la skill nota-prueba."

$argumentos = "-w new new-tab --title `"$titulo`" -d `"$repo`" `"$claude`" `"$prompt`""
Log "Abriendo nota #$id en $repo"
Start-Process -FilePath 'wt.exe' -ArgumentList $argumentos
