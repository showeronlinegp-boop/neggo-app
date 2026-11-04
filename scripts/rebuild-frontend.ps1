# Compila frontend/dist sin Node en Windows.
# Reemplaza el docker run que se copiaba a mano (la ruta del usuario iba fija y Docker
# no está en el PATH). Solo monta frontend/ y el volumen de node_modules. No lee .env,
# no levanta compose y no toca la base ni Odoo.
#
#   .\scripts\rebuild-frontend.ps1          # compila
#   .\scripts\rebuild-frontend.ps1 -Check   # revisa Docker y la ruta, no compila
#
# Nginx sirve el dist del checkout desde el que se levantó compose. Corré este script
# en ese checkout para que http://localhost muestre el build.

param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$frontend = Join-Path $repo 'frontend'
$packageJson = Join-Path $frontend 'package.json'
$packageLock = Join-Path $frontend 'package-lock.json'

if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "No encuentro $packageJson"
}
if (-not (Test-Path -LiteralPath $packageLock)) {
    throw "No encuentro $packageLock (npm ci lo necesita)"
}

function Find-Docker {
    $cmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    $fallback = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    return $null
}

$docker = Find-Docker
if (-not $docker) {
    throw "No encuentro docker. Instalá Docker Desktop o agregalo al PATH."
}

# Docker en Windows acepta la ruta con barras normales, también si tiene espacios.
$mount = ($frontend -replace '\\', '/')
$buildArgs = @(
    'run', '--rm',
    '-v', "${mount}:/app",
    '-v', 'neggo_front_nm:/app/node_modules',
    '-w', '/app',
    'node:20-alpine',
    'sh', '-c', 'npm ci --no-audit --no-fund --loglevel=error && npm run build'
)

Write-Host "Repo:     $repo"
Write-Host "Frontend: $frontend"
Write-Host "Docker:   $docker"
Write-Host "Comando:  docker $($buildArgs -join ' ')"

& $docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Docker no responde. Abrí Docker Desktop y esperá a que arranque."
}

if ($Check) {
    Write-Host "CHECK OK: Docker responde y el frontend está en su lugar. No se compiló nada."
    exit 0
}

Write-Host "Compilando frontend..."
& $docker @buildArgs
if ($LASTEXITCODE -ne 0) {
    throw "Falló el build del frontend (docker exit $LASTEXITCODE)."
}

$index = Join-Path $frontend 'dist\index.html'
if (-not (Test-Path -LiteralPath $index)) {
    throw "El build terminó pero no apareció $index"
}

$info = Get-Item -LiteralPath $index
Write-Host "OK: $($info.FullName) ($($info.Length) bytes, $($info.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')))"
exit 0
