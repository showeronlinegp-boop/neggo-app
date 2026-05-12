---
name: code-conventions
description: Convenciones de código del proyecto Neggo App. Leer si hay dudas sobre patrones, estilo, estructura de archivos o naming. Cubre backend (Express/CommonJS), frontend (React inline styles), y SQL.
---

# Convenciones de código

## Backend (Express.js / CommonJS)

### Imports
```javascript
// ✅ Correcto
const express = require('express');
const { Pool } = require('pg');

// ❌ Incorrecto
import express from 'express';
```

### Estructura de un archivo de rutas
```javascript
const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const pool = require('../config/database');

// GET /api/recurso
router.get('/', authenticate, async (req, res) => {
    try {
        const { rows, rowCount } = await pool.query(
            'SELECT * FROM tabla WHERE active = true ORDER BY name LIMIT $1 OFFSET $2',
            [req.query.limit || 50, req.query.offset || 0]
        );
        return paginated(res, rows, rowCount, req.query.limit, req.query.offset);
    } catch (error) {
        console.error('❌ Error obteniendo recurso:', error.message);
        return fail(res, 'Error interno del servidor', 500);
    }
});

module.exports = router;
```

### SQL parametrizado
```javascript
// ✅ Siempre parametrizado
await pool.query('SELECT * FROM users WHERE id = $1 AND active = $2', [id, true]);

// ✅ Insert con RETURNING
const { rows } = await pool.query(
    'INSERT INTO suppliers (name, prefix) VALUES ($1, $2) RETURNING *',
    [name, prefix]
);

// ✅ Upsert
await pool.query(`
    INSERT INTO supplier_products (supplier_id, sku, name, raw_price)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (supplier_id, sku) DO UPDATE SET
        name = EXCLUDED.name,
        raw_price = EXCLUDED.raw_price,
        updated_at = NOW()
`, [supplierId, sku, name, price]);

// ❌ NUNCA interpolación de strings
await pool.query(`SELECT * FROM users WHERE id = ${id}`); // SQL INJECTION
```

### Responses
```javascript
// Éxito
return ok(res, { user });          // 200
return ok(res, { id }, 201);       // 201 Created

// Error
return fail(res, 'No encontrado', 404);
return fail(res, 'No autorizado', 401);
return fail(res, 'Acceso denegado', 403);

// Paginado
return paginated(res, rows, totalCount, limit, offset);
```

## Frontend (React)

### Inline styles
```jsx
// ✅ Correcto: objetos JS
const styles = {
    container: {
        padding: '24px',
        backgroundColor: '#F5F5F5',
        borderRadius: '8px'
    },
    title: {
        fontSize: '20px',
        fontWeight: '600',
        color: '#003366',
        marginBottom: '16px'
    }
};

return <div style={styles.container}><h1 style={styles.title}>Título</h1></div>;

// ❌ Incorrecto
import './styles.css';
<div className="container">
```

### Componentes
```jsx
// ✅ Funcional con hooks
function SupplierList() {
    const [suppliers, setSuppliers] = useState([]);
    const [loading, setLoading] = useState(true);
    // ...
}

// ✅ Export default
export default SupplierList;

// ❌ Class components
class SupplierList extends React.Component { }
```

### Paleta de colores
```javascript
const COLORS = {
    primary: '#003366',
    secondary: '#FF6600',
    text: '#333333',
    gray: '#666666',
    lightGray: '#999999',
    bg: '#F5F5F5',
    white: '#FFFFFF',
    success: '#28a745',
    danger: '#dc3545',
    warning: '#ffc107',
    info: '#17a2b8',
    border: '#dee2e6'
};
```

### Textos en español rioplatense
```jsx
// ✅ Voseo
"Ingresá tu usuario"
"Seleccioná un proveedor"
"¿Estás seguro de que querés eliminar?"
"No se encontraron resultados"

// ❌ Tuteo
"Ingresa tu usuario"
"Selecciona un proveedor"
```

## Naming

| Qué | Convención | Ejemplo |
|-----|-----------|---------|
| Archivos JS backend | camelCase | `odooService.js` |
| Archivos JSX frontend | PascalCase | `SupplierList.jsx` |
| Tablas SQL | snake_case | `supplier_products` |
| Columnas SQL | snake_case | `raw_price` |
| Variables JS | camelCase | `supplierProduct` |
| Constantes | UPPER_SNAKE | `MAX_CONCURRENT_SCRAPERS` |
| Endpoints API | kebab-case | `/api/price-alerts` |
| Componentes React | PascalCase | `DataTable` |
