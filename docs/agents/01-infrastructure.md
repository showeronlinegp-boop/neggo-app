# Agente 01 — Infraestructura

## Objetivo
Crear la infraestructura base del proyecto: Docker Compose, PostgreSQL con schema, Nginx, y scaffold del proyecto Node.js + React.

## Skills a leer antes de empezar
- `docs/skills/project-context/SKILL.md`

## Dependencias
Ninguna. Este es el primer agente.

## Tareas

### 1. Docker Compose
Crear `docker-compose.yml` con 4 servicios:

- **nginx**: imagen `nginx:alpine`, puerto 80:80, sirve frontend estático y proxy al backend
- **backend**: build desde `./backend`, puerto interno 3000, conecta a postgres y chrome
- **postgres**: imagen `postgres:15-alpine`, volumen persistente en `./volumes/pg_data`
- **chrome**: imagen `browserless/chrome:latest`, máx 2 sesiones concurrentes

Crear archivo `.env.example` con todas las variables necesarias.

### 2. Nginx
Crear `nginx/nginx.conf`:
- `/` → sirve archivos estáticos del frontend (try_files con fallback a index.html para SPA)
- `/api/` → proxy_pass a backend:3000
- `/storage/` → alias a carpeta de archivos estáticos (fotos, catálogos)
- `client_max_body_size 50M` para uploads de fotos

### 3. Backend scaffold
Inicializar `backend/package.json` con dependencias:
```
express, pg, jsonwebtoken, bcryptjs, cors, multer, node-cron,
puppeteer-core, pdfkit, sharp, dotenv
```

Crear `backend/server.js`:
- Express app con middlewares (json, cors, morgan)
- Health check en GET /api/health
- Carga de rutas desde /routes/
- Escucha en puerto 3000
- Manejo global de errores

Crear `backend/Dockerfile`:
- Imagen `node:20-alpine`
- WORKDIR /app
- Copiar package.json, npm install, copiar código
- CMD node server.js

Crear `backend/config/database.js`:
- Pool de pg con `DATABASE_URL` de env
- Export del pool para usar en toda la app

### 4. PostgreSQL schema
Crear `backend/sql/schema.sql` con TODAS las tablas definidas en el plan maestro (ver `neggo-app-plan.md` sección "Base de datos PostgreSQL — Schema").

Crear `backend/sql/seeds.sql`:
- Usuario admin por defecto (username: admin, password hasheada de 'admin123')
- 5 proveedores iniciales: Cast, Mali, El Rey, Impotekno, Neggo-Odoo
  con sus prefijos, URLs y configuración base

### 5. Frontend scaffold
Inicializar proyecto React con Vite:
```bash
cd frontend && npm create vite@latest . -- --template react
```

Instalar dependencias: `react-router-dom`

Crear `frontend/manifest.json` para PWA con:
- name: "Neggo App"
- short_name: "Neggo"
- theme_color: "#003366"
- background_color: "#F5F5F5"
- display: "standalone"
- icons (placeholder 192x192 y 512x512)

Crear `frontend/vite.config.js` con proxy al backend para desarrollo.

Crear `frontend/src/main.jsx` y `frontend/src/App.jsx` con router básico:
- /login → Login page (placeholder)
- / → Dashboard (placeholder con texto "Neggo App")
- Rutas protegidas con auth context

### 6. Verificación
Crear `scripts/verify-setup.ps1` (PowerShell) que:
1. Ejecuta `docker-compose up -d`
2. Espera 10 segundos
3. Verifica que cada servicio está corriendo
4. Hace GET a http://localhost/api/health
5. Verifica conexión a PostgreSQL
6. Imprime resumen

## Criterios de éxito
- [ ] `docker-compose up -d` levanta los 4 servicios sin errores
- [ ] GET http://localhost/api/health retorna `{ success: true }`
- [ ] PostgreSQL tiene todas las tablas creadas
- [ ] El frontend carga en http://localhost (aunque sea placeholder)
- [ ] El usuario admin puede autenticarse (seed)
