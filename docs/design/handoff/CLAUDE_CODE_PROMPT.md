# Prompt para Claude Code — Reestructurar el frontend de Neggo

> Pegá esto en Claude Code como primer mensaje. Si lo dividís en pasos, mejor:
> Claude Code rinde mucho más con tareas chicas y verificables.

---

## Contexto

Estoy reestructurando el frontend de la app `neggo-app` siguiendo un nuevo
lenguaje de diseño aprobado. La referencia visual y el sistema están en:

- `docs/design/DESIGN_SYSTEM.md` — sistema completo, tokens y reglas duras
- `docs/design/tokens.js` — fuente única de tokens (color, espacio, tipografía)
- `docs/design/prototype/Neggo App.html` — prototipo HTML aprobado, con todos
  los componentes y patrones implementados como referencia visual

Reglas inmutables del proyecto (ya están en `CLAUDE.md`):

- React 18 con **inline styles como objetos JS**. No CSS, no Tailwind, no
  styled-components.
- Componentes funcionales con hooks.
- Voseo rioplatense en toda la UI.

---

## Lo que necesito

Reestructurar todo el frontend para que use el nuevo sistema de diseño,
**en pasos verificables**. Andá módulo por módulo, no toques todo a la vez.

### Paso 1 — Setup del sistema

1. Copiar `docs/design/tokens.js` a `frontend/src/theme/tokens.js`. Adaptarlo
   al sistema de módulos del proyecto (ESM si Vite, CommonJS si lo necesita).
2. Crear `frontend/src/theme/ThemeContext.jsx` con un provider que exponga
   `{ tokens, theme, setTheme }`. Default `'light'`. Persistir en localStorage.
3. Wrappear `<App>` en el provider en `main.jsx`.
4. Agregar el font-import de Inter + JetBrains Mono en `index.html`.
5. **Verificar**: la app sigue funcionando, podés cambiar `theme` desde
   devtools y todo se actualiza.

### Paso 2 — Componentes base en `components/common/`

Mirando la implementación de referencia en `docs/design/prototype/src/ui.jsx`,
crear/refactorizar:

- `Button.jsx` — variantes primary/secondary/ghost/danger/success/accent + sizes
- `Badge.jsx` — tones primary/success/warn/danger/accent/muted + `dot`
- `Card.jsx` — wrapper con border + shadow.card + padding configurable
- `Input.jsx` — con `leftIcon`/`rightIcon`, focus ring suave
- `Select.jsx` — dropdown custom (no `<select>` nativo)
- `Modal.jsx` — con title, subtitle, footer slots, escape para cerrar
- `ProductThumb.jsx` — thumb cuadrado con tinte determinístico por hash
- `Stat.jsx` — KPI con label, value, hint, icon
- `Tabs.jsx` — tabs subrayadas con count opcional
- `Toggle.jsx` — switch pill

Todos deben:
- Importar tokens desde `theme/tokens.js`
- Aceptar `style` prop para overrides puntuales
- Manejar tema oscuro automáticamente vía contexto
- Tener archivos `< 200 líneas` cada uno

Adaptar `DataTable.jsx` que ya existe para que use el nuevo sistema (header con
bg `surface2`, label uppercase 600, filas con borde superior, hover surface2).

### Paso 3 — Layout y navegación

- Refactorizar `components/Layout.jsx` siguiendo la estructura del prototipo
  (sidebar 240px + topbar + main scrollable).
- Sidebar con secciones "Operación" y "Admin" como labels uppercase.
- Items con icon 17px + label + badge opcional. Activo con bg `primarySoft`.
- Mobile: sidebar colapsable con overlay, botón hamburguesa en topbar.
- Topbar con `<h1>` 22px peso 600, subtitle 13px muted, slot de actions a la
  derecha.

### Paso 4 — Página por página

Para cada página de `pages/`, refactorizar siguiendo el patrón del prototipo
correspondiente. Hacé una por PR/commit, no todas juntas:

| Página actual                          | Referencia en prototipo |
|----------------------------------------|------------------------|
| `Login.jsx`                            | Split brand + form     |
| `Dashboard.jsx`                        | KPIs + alertas + scraping + actividad |
| `pages/products/SupplierProducts.jsx`  | Tabla + filtros + modal |
| `pages/products/ProductMappings.jsx`   | Misma tabla pero con suggestions de Odoo |
| `pages/alerts/PriceAlerts.jsx`         | Cards con tabs por estado |
| `pages/preventas/ClientOrders.jsx`     | Lista + nuevo pedido (catálogo + carrito) |
| `pages/preventas/SupplierOrders.jsx`   | Tabla con agrupación por proveedor |
| `pages/scraping/ScrapingPanel.jsx`     | Lista de proveedores con run + log |
| `pages/suppliers/SupplierList.jsx`     | Tabla simple |
| `pages/suppliers/SupplierRules.jsx`    | Form + tabla de reglas por categoría |
| `pages/admin/Users.jsx`                | Tabla + modal de form |
| `pages/admin/ActivityLog.jsx`          | Tabla con filtros |

Reglas para cada refactor:
- **No** cambiar la lógica de negocio ni los endpoints. Sólo presentación.
- Reusar **siempre** componentes de `common/`. Si falta algo genérico,
  agregarlo a `common/` antes de usarlo en la página.
- Tablas: thumb + nombre + SKU mono debajo en la primera columna.
- Precios: `tabular-nums` y alineados a la derecha.
- Estados con `<Badge dot>`.
- Mobile-first: probar en 375px de ancho antes de mergear.

### Paso 5 — Cleanup

- Eliminar estilos hardcodeados que quedaron de la versión vieja (grep por
  `'#003366'`, `'#FF6600'`, `'#F5F5F5'` y reemplazar por tokens).
- Eliminar componentes duplicados o no usados.
- Correr la app y verificar las 13 páginas a mano.

---

## Cómo trabajar conmigo

- **Un paso por turno**. Cuando termines un paso, mostrame qué cambió y esperá
  feedback antes de avanzar.
- Si algo del sistema no cubre un caso real, **preguntame** antes de inventar
  un valor o componente nuevo. Lo agregamos al sistema y después lo usás.
- No toques `backend/` ni `docker-compose.yml` en este reestructuro.
- Si encontrás bugs en la lógica existente, dejá un `TODO` con tu nombre y
  seguí — los arreglamos en otro PR.

---

## Comando de arranque sugerido

```
Leé docs/design/DESIGN_SYSTEM.md y docs/design/tokens.js. Después miré tres
archivos del prototipo de referencia para entender el estilo:
docs/design/prototype/src/ui.jsx, docs/design/prototype/src/Products.jsx,
docs/design/prototype/src/Alerts.jsx. Cuando estés listo, decime "OK, leí
todo" y arrancamos por el Paso 1.
```
