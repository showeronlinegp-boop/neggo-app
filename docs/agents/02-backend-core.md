# Agente 02 — Backend core (Auth + Activity)

## Objetivo
Implementar autenticación JWT, middleware de activity log, CRUD de usuarios, y la estructura base de rutas/servicios.

## Skills a leer antes de empezar
- `docs/skills/project-context/SKILL.md` (sección Usuarios y roles)

## Dependencias
- Agente 01 completado (Docker, PostgreSQL, Express scaffold)

## Tareas

### 1. Middleware de autenticación
Crear `backend/middleware/auth.js`:
- Extrae JWT del header `Authorization: Bearer <token>`
- Verifica y decodifica con `jsonwebtoken`
- Agrega `req.user = { id, username, role }` al request
- Función helper `requireRole(...roles)` para proteger por rol
- Si falla → 401 con `{ success: false, error: 'No autorizado' }`

### 2. Middleware de activity log
Crear `backend/middleware/activityLog.js`:
- Se aplica DESPUÉS del handler (en el response)
- Registra en tabla `activity_log`: user_id, module (extraer de la ruta), action (método HTTP), entity_type, entity_id (si aplica), ip_address
- No bloquea el response: usar fire-and-forget (no awaitar el INSERT)
- Excluir rutas de health check y assets estáticos

### 3. Rutas de autenticación
Crear `backend/routes/auth.js`:

**POST /api/auth/login**
- Body: `{ username, password }`
- Buscar usuario por username, verificar bcrypt
- Si ok → generar JWT (expira en 24h) con { id, username, role }
- Response: `{ success: true, data: { token, user: { id, username, displayName, role } } }`

**POST /api/auth/logout**
- En esta implementación con JWT stateless, solo retorna success
- El frontend descarta el token

**GET /api/auth/me**
- Requiere auth
- Retorna datos del usuario actual desde DB (sin password_hash)

### 4. CRUD de usuarios
Crear `backend/routes/users.js`:
- Todas las rutas requieren rol 'admin'

**GET /api/users** — Lista todos los usuarios activos
**POST /api/users** — Crear usuario (hashear password con bcrypt)
**PUT /api/users/:id** — Editar usuario (si envía password, rehashear)
**DELETE /api/users/:id** — Soft delete (active = false)

### 5. Ruta de activity log
Crear `backend/routes/activityLog.js`:
- Requiere rol 'admin'

**GET /api/activity-log** — Filtrable por:
- `user_id`, `module`, `action`
- `from` y `to` (rango de fechas)
- Paginación con `limit` y `offset`
- Order: `created_at DESC`

### 6. Estructura base de server.js
Actualizar `backend/server.js` para:
- Cargar dotenv
- Configurar middlewares globales (json, cors, morgan)
- Montar rutas: auth, users, activityLog
- Aplicar middleware de activityLog a todas las rutas /api/ excepto auth/login
- Error handler global
- Graceful shutdown (cerrar pool de PostgreSQL)

### 7. Utilidades
Crear `backend/utils/response.js`:
```javascript
function ok(res, data, status = 200) {
    return res.status(status).json({ success: true, data });
}
function fail(res, error, status = 400) {
    return res.status(status).json({ success: false, error });
}
function paginated(res, data, total, limit, offset) {
    return res.json({ success: true, data, pagination: { total, limit, offset } });
}
```

## Criterios de éxito
- [ ] POST /api/auth/login con admin/admin123 retorna token JWT válido
- [ ] GET /api/auth/me con token retorna datos del admin
- [ ] CRUD de usuarios funciona completo
- [ ] Cada request API queda registrado en activity_log
- [ ] Rutas protegidas rechazan requests sin token (401)
- [ ] Rutas de admin rechazan requests de otros roles (403)
