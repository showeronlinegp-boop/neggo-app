# Agente 08 — Frontend shell (PWA + Layout + Componentes comunes)

## Objetivo
Crear la estructura completa del frontend React: PWA configuration, layout con sidebar, sistema de rutas protegidas, auth context, API client, y componentes reutilizables.

## Skills a leer
- `docs/skills/project-context/SKILL.md` (roles, módulos)
- `CLAUDE.md` (convenciones de frontend)

## Dependencias
- Agente 02 completado (auth backend)

## Reglas de estilo
- INLINE STYLES SOLAMENTE. Objetos JS, no strings. No CSS files.
- Paleta: primary=#003366, secondary=#FF6600, text=#333, gray=#666, bg=#F5F5F5, white=#FFF
- Border radius: 8px para cards, 4px para inputs/botones
- Font: system-ui (no instalar fonts externas)
- Responsive: flexbox, no media queries complejas. Mobile-first.
- UI en español rioplatense (voseo): "Ingresá", "Seleccioná", etc.

## Tareas

### 1. API Client
Crear `frontend/src/api/client.js`:
- Wrapper sobre fetch con baseURL
- Inyecta token JWT en headers automáticamente
- Manejo de errores: si 401 → redirect a login
- Métodos: `get(url)`, `post(url, body)`, `put(url, body)`, `del(url)`

### 2. Auth Context
Crear `frontend/src/context/AuthContext.jsx`:
- Estado: user, token, loading
- Métodos: login(username, password), logout()
- Persistir token en localStorage
- Al montar: verificar token con GET /api/auth/me

### 3. Layout principal
Crear `frontend/src/components/Layout.jsx`:
- Sidebar izquierda (colapsable en mobile) con navegación:
  - Dashboard
  - Proveedores (admin)
  - Scraping (admin)
  - Productos
  - Alertas de precio
  - Preventas: Pedidos / Órdenes / Catálogos
  - Usuarios (admin)
  - Actividad (admin)
- Header con nombre del usuario, rol, botón logout
- Content area con scroll
- Sidebar muestra solo los items según el rol del usuario
- Indicador de alertas pendientes (badge numérico en "Alertas")

### 4. Componentes comunes
Crear en `frontend/src/components/common/`:

**DataTable.jsx** — Tabla genérica:
- Props: columns, data, loading, onRowClick
- Paginación (limit/offset)
- Columnas con sort
- Estado de loading con skeleton

**Modal.jsx** — Modal overlay:
- Props: isOpen, onClose, title, children
- Cierra con Escape y click fuera

**SearchInput.jsx** — Input de búsqueda con debounce (300ms)

**StatusBadge.jsx** — Badge de estado con colores:
- pending=naranja, approved=verde, dismissed=gris, running=azul, failed=rojo

**LoadingSpinner.jsx** — Spinner simple

**ConfirmDialog.jsx** — Diálogo de confirmación (¿Estás seguro?)

**Toast.jsx** — Notificaciones temporales (éxito, error, warning)
- Crear ToastContext para usar desde cualquier componente

### 5. Router y rutas protegidas
Actualizar `frontend/src/App.jsx`:
- ProtectedRoute que verifica auth
- RoleRoute que verifica rol mínimo
- Todas las rutas definidas en la estructura de carpetas
- Redirect a /login si no hay sesión

### 6. Service Worker + PWA
Crear `frontend/sw.js`:
- Cache-first para assets estáticos (JS, CSS, imágenes)
- Network-first para API calls
- Offline fallback page

Actualizar `frontend/manifest.json` con configuración completa.
Registrar SW en `frontend/src/main.jsx`.

### 7. Login page
Crear `frontend/src/pages/Login.jsx`:
- Formulario centrado con logo "Neggo"
- Inputs: usuario, contraseña
- Botón "Ingresar"
- Error feedback
- Redirect a / después de login exitoso

## Criterios de éxito
- [ ] Login funciona y persiste sesión
- [ ] Layout responsive con sidebar colapsable
- [ ] Navegación muestra items según rol
- [ ] PWA se puede instalar en Chrome mobile
- [ ] Componentes comunes funcionan de forma aislada
- [ ] Badge de alertas muestra conteo real del backend
