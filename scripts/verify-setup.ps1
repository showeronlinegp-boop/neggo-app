# Neggo App — Script de verificación de setup
# Ejecutar desde la raíz del proyecto: .\scripts\verify-setup.ps1

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Neggo App — Verificación de Setup" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# 1. Verificar Docker
Write-Host "[1/6] Verificando Docker..." -ForegroundColor Yellow
$dockerVersion = docker --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Docker no está instalado o no está corriendo" -ForegroundColor Red
    exit 1
}
Write-Host "  OK: $dockerVersion" -ForegroundColor Green

# 2. Verificar archivo .env
Write-Host "[2/6] Verificando .env..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Write-Host "  ADVERTENCIA: No se encontró .env, copiando de .env.example..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
    Write-Host "  Creado .env — editá los valores antes de producción" -ForegroundColor Yellow
} else {
    Write-Host "  OK: .env existe" -ForegroundColor Green
}

# 3. Build del frontend (si no existe dist/)
Write-Host "[3/6] Verificando frontend build..." -ForegroundColor Yellow
if (-not (Test-Path "frontend/dist/index.html")) {
    Write-Host "  Construyendo frontend..." -ForegroundColor Yellow
    Push-Location frontend
    npm install 2>&1 | Out-Null
    npm run build 2>&1 | Out-Null
    Pop-Location
    if (Test-Path "frontend/dist/index.html") {
        Write-Host "  OK: Frontend construido" -ForegroundColor Green
    } else {
        Write-Host "  ADVERTENCIA: No se pudo construir el frontend" -ForegroundColor Yellow
    }
} else {
    Write-Host "  OK: Frontend ya construido" -ForegroundColor Green
}

# 4. Levantar servicios
Write-Host "[4/6] Levantando Docker Compose..." -ForegroundColor Yellow
docker-compose up -d --build 2>&1 | Out-Null
Start-Sleep -Seconds 12

# 5. Verificar servicios
Write-Host "[5/6] Verificando servicios..." -ForegroundColor Yellow

$services = @("nginx", "backend", "postgres", "chrome")
$allOk = $true

foreach ($svc in $services) {
    $status = docker-compose ps --format json $svc 2>&1 | ConvertFrom-Json
    if ($status.State -eq "running") {
        Write-Host "  OK: $svc corriendo" -ForegroundColor Green
    } else {
        Write-Host "  ERROR: $svc no está corriendo" -ForegroundColor Red
        $allOk = $false
    }
}

# 6. Test endpoints
Write-Host "[6/6] Testeando endpoints..." -ForegroundColor Yellow

# Health check
try {
    $health = Invoke-RestMethod -Uri "http://localhost/api/health" -TimeoutSec 10
    if ($health.success) {
        Write-Host "  OK: /api/health responde (v$($health.data.version))" -ForegroundColor Green
    }
} catch {
    Write-Host "  ERROR: /api/health no responde" -ForegroundColor Red
    $allOk = $false
}

# Login test
try {
    $loginBody = @{ username = "admin"; password = "admin123" } | ConvertTo-Json
    $login = Invoke-RestMethod -Uri "http://localhost/api/auth/login" -Method POST -Body $loginBody -ContentType "application/json" -TimeoutSec 10
    if ($login.success) {
        Write-Host "  OK: Login admin funciona" -ForegroundColor Green
    }
} catch {
    Write-Host "  ERROR: Login no funciona" -ForegroundColor Red
    $allOk = $false
}

# Frontend
try {
    $frontend = Invoke-WebRequest -Uri "http://localhost/" -TimeoutSec 10
    if ($frontend.StatusCode -eq 200) {
        Write-Host "  OK: Frontend carga correctamente" -ForegroundColor Green
    }
} catch {
    Write-Host "  ERROR: Frontend no carga" -ForegroundColor Red
    $allOk = $false
}

# Resumen
Write-Host "`n========================================" -ForegroundColor Cyan
if ($allOk) {
    Write-Host "  RESULTADO: Todo OK" -ForegroundColor Green
    Write-Host "  Acceder a: http://localhost" -ForegroundColor Cyan
    Write-Host "  Admin: admin / admin123" -ForegroundColor Cyan
} else {
    Write-Host "  RESULTADO: Hay errores" -ForegroundColor Red
    Write-Host "  Revisar: docker-compose logs" -ForegroundColor Yellow
}
Write-Host "========================================`n" -ForegroundColor Cyan
