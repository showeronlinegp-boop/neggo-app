# Agente 09 — Páginas del frontend (Fase 1)

## Objetivo
Implementar todas las páginas del frontend que consumen los endpoints de los agentes 02-07.

## Dependencias
- Agentes 02-08 completados

## Páginas a implementar

### 1. Dashboard (`pages/Dashboard.jsx`)
- Cards resumen: alertas Neggo pendientes, último scraping (fecha + proveedor),
  pedidos activos, productos sin vincular, resumen diario de actualizaciones Preventas
- Cada card es clickeable y lleva a la sección correspondiente
- Datos de: GET /api/alerts/summary, GET /api/scraping/runs (último),
  GET /api/preventas/client-orders?status=pendiente

### 2. Proveedores (`pages/suppliers/SupplierList.jsx`)
- DataTable con: nombre, prefijo, web, último scraping, productos, estado
- Badge naranja en el ítem "Proveedores" del sidebar cuando hay categorías pendientes
- Botón "Nuevo proveedor" → Modal con formulario
- Click en fila → ir a SupplierRules

### 3. Reglas de proveedor (`pages/suppliers/SupplierRules.jsx`)
- Header con datos del proveedor (editables inline)
- Sección "Reglas globales": default_discount, default_markup, price_format, is_published
- Sección "Reglas por categoría": DataTable editable con columnas:
  - source_category (categoría del proveedor)
  - dest_category_neggo (destino en Neggo)
  - dest_category_preventas (destino en Preventas)
  - discount_override, markup_override
  - ignored (checkbox)
- Botón "Importar desde Excel" → upload de Maestro Preventas.xlsx
- Preview de cálculo de precios (input: precio proveedor → costo y venta para ambas empresas)

#### Sub-sección: Categorías pendientes
- Si hay categorías pendientes para este proveedor, mostrar panel colapsable debajo de la tabla
- Por cada categoría pendiente:
  - Nombre de la categoría (como vino del scraping)
  - Muestra de hasta 5 productos de esa categoría (para dar contexto)
  - Formulario inline: dest_category_neggo, dest_category_preventas + botón "Mapear"
  - Botón "Ignorar" para descartar la categoría
- Al resolver, desaparece del panel y se crea la regla en supplier_category_rules

### 4. Panel de scraping (`pages/scraping/ScrapingPanel.jsx`)
- Lista de proveedores con botón "Ejecutar" cada uno
- Al ejecutar: estado en tiempo real (polling cada 5 seg a GET /api/scraping/runs/:id)
- Historial de ejecuciones con stats (encontrados, nuevos, actualizados, cambios, errores)
- Click en ejecución → detalle con errores
- Indicador de categorías nuevas detectadas en la última ejecución

### 5. Productos de proveedores (`pages/products/SupplierProducts.jsx`)
- DataTable con: imagen (thumbnail), nombre, SKU, precio, categoría, proveedor, disponible
- Filtros: proveedor (dropdown), categoría, búsqueda por nombre, solo disponibles
- Click en producto → modal con detalle + historial de precios + preview de precios
  calculados para Neggo y Preventas + productos Odoo vinculados

### 6. Vínculos de productos (`pages/products/ProductMappings.jsx`)
- Dos paneles lado a lado:
  - Izquierda: productos del proveedor sin vincular (con filtros)
  - Derecha: productos Odoo del cache (con búsqueda)
- Botón "Vincular" entre los dos seleccionados
- Botón "Auto-match" → ejecuta POST /api/mappings/auto-match y muestra resumen
- Lista de vínculos existentes con botón "Desvincular"

### 7. Alertas de precios (`pages/alerts/PriceAlerts.jsx`)
- Tabs: **Pendientes (Neggo)** | **Historial Neggo** | **Actualizaciones Preventas**
- Tab "Pendientes (Neggo)":
  - DataTable: producto, proveedor, precio anterior, precio nuevo, % cambio, fecha
  - Fila expandible: comparativa entre proveedores del mismo producto
  - Botones: "Aprobar" (recalcula + actualiza Odoo), "Descartar" (con nota opcional)
  - Colores: aumento=rojo, baja=verde, sin stock=gris
- Tab "Actualizaciones Preventas":
  - Solo lectura, muestra las actualizaciones automáticas con fecha y % de cambio
  - Para trazabilidad y auditoría

### 8. Preventas: Pedidos (`pages/preventas/ClientOrders.jsx`)
- DataTable con: cliente, fecha, items, total estimado, estado
- Botón "Nuevo pedido" → formulario con:
  - Datos del cliente (nombre, teléfono)
  - Buscador de productos (busca en supplier_products, muestra imagen + precio Preventas calculado)
  - Lista de items agregados con cantidad editable
  - Total estimado calculado con reglas de Preventas
- Click en pedido → detalle con items y acciones (cambiar estado, editar)

### 9. Preventas: Órdenes a proveedores (`pages/preventas/SupplierOrders.jsx`)
- Botón "Generar órdenes": seleccionar pedidos pendientes → POST /api/preventas/generate-supplier-orders
- DataTable de órdenes: proveedor, items, total, estado
- Botón "Enviar a Odoo" por orden → crea purchase.order
- Trazabilidad: de qué pedido de cliente viene cada item

### 10. Preventas: Catálogos (`pages/preventas/Catalogs.jsx`)
- Formulario: tipo (preventas/neggo), proveedor, categoría
- Botón "Generar catálogo" → POST /api/catalogs/generate
- Lista de catálogos generados con link de descarga
- Preview del PDF (si el navegador lo soporta)

### 11. Usuarios (`pages/admin/Users.jsx`)
- Solo visible para admin
- DataTable con: nombre, username, rol, activo
- CRUD completo en modal

### 12. Log de actividad (`pages/admin/ActivityLog.jsx`)
- Solo visible para admin
- DataTable con: fecha, usuario, módulo, acción, detalle
- Filtros: usuario, módulo, rango de fechas

## Patrón de página
Cada página sigue este patrón:
```jsx
const [data, setData] = useState([]);
const [loading, setLoading] = useState(true);
const [filters, setFilters] = useState({});

useEffect(() => { fetchData(); }, [filters]);

async function fetchData() {
    setLoading(true);
    const res = await api.get('/api/...', filters);
    if (res.success) setData(res.data);
    setLoading(false);
}

return (
    <div>
        {/* Filtros */}
        {/* DataTable o contenido */}
        {/* Modal para crear/editar */}
    </div>
);
```

## Criterios de éxito
- [ ] Todas las páginas cargan datos reales del backend
- [ ] CRUD funciona en todas las entidades
- [ ] Responsive: usable en celular, tablet y PC
- [ ] Reglas de categoría muestran columnas neggo Y preventas separadas
- [ ] Panel de categorías pendientes aparece en SupplierRules cuando hay pendientes
- [ ] Alertas de Neggo se pueden aprobar/descartar
- [ ] Tab de Preventas muestra actualizaciones automáticas (solo lectura)
- [ ] Pedidos de Preventas se crean con selección visual de productos
- [ ] Catálogos PDF se generan y descargan correctamente
