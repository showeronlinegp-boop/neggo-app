# Neggo — Sistema de diseño

> Referencia viva. Antes de modificar cualquier UI, leé este archivo y mirá el
> prototipo en `handoff/prototype/Neggo App.html`.

La app usa **inline styles** (regla del proyecto: ni CSS frameworks ni CSS-in-JS).
Para mantener consistencia sin romper esa regla, todos los valores de diseño
viven en `frontend/src/theme/tokens.js` y se importan donde se necesiten.

---

## 1. Filosofía

- **Aireado, no denso**. Pocas cosas a la vez, con jerarquía clara.
- **Color con propósito**. El navy es el primario, el naranja sólo para acentos
  críticos (alertas con suba, CTA destacado, badge "preventas").
- **Texto > iconos**. Iconos sólo cuando aportan claridad, nunca decorativos.
- **Tablas legibles**. Cada fila lleva thumb + nombre + SKU mono debajo.
- **Voseo rioplatense** en toda la copy (UI, mensajes, errores).
- **Estados semánticos**. Suba de precio = danger, baja = success, sin stock = danger.

---

## 2. Tokens

Todos en `frontend/src/theme/tokens.js`. **No hardcodear** colores, paddings o
radios en componentes — siempre importar desde tokens.

### Color (claro)

| Token            | Valor      | Uso                                |
|------------------|------------|------------------------------------|
| `bg`             | `#fbfaf7`  | Fondo de la app                    |
| `surface`        | `#ffffff`  | Cards, modales, sidebar            |
| `surface2`       | `#f5f3ee`  | Hover de filas, hero de cards      |
| `border`         | `#e8e3d8`  | Separadores y bordes suaves        |
| `borderStrong`   | `#d8d2c2`  | Bordes de inputs y botones         |
| `text`           | `#1c1c1a`  | Texto principal                    |
| `textMuted`      | `#6b6a64`  | Texto secundario, labels           |
| `textFaint`      | `#9a988f`  | Metadata, timestamps               |
| `primary`        | `#1f3a68`  | Acciones primarias, links activos  |
| `primaryHover`   | `#162a4d`  | Hover del primario                 |
| `primarySoft`    | `#eaf0f9`  | Bg de badges/items activos         |
| `accent`         | `#e25a1c`  | Acentos críticos (Preventas, etc.) |
| `accentSoft`     | `#fdeee3`  | Bg de badges accent                |
| `success` / `successSoft` | `#2f7a47` / `#e6f1e9` | Stock OK, baja de precio |
| `warn` / `warnSoft`       | `#b8740d` / `#fbf0d9` | Pedido pendiente |
| `danger` / `dangerSoft`   | `#b53a2a` / `#fbe5e1` | Sin stock, suba de precio |

### Color (oscuro)

Tokens equivalentes — ver `tokens.js`. La app debe poder cambiar tema vía
`ThemeContext` o atributo en `<html data-theme="dark">`.

### Tipografía

- Familia UI: `'Inter', -apple-system, 'Helvetica Neue', sans-serif`
- Familia mono: `'JetBrains Mono', ui-monospace, monospace` (sólo para SKUs,
  códigos, timestamps técnicos)
- Tamaños: `xs 12px`, `sm 13px`, `base 14px`, `lg 16px`, `xl 22px`, `2xl 28px`
- Pesos: 400 / 500 / 600 / 700
- Letter-spacing: `-0.02em` para títulos > 20px
- **Números** siempre con `fontVariantNumeric: 'tabular-nums'` (ya está la
  utilidad `numericStyle` en tokens)

### Espaciado

Stack base de 4px: `4 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 32 · 48`.
Padding de cards: `padX 28 · padY 22` en densidad equilibrada.

### Radios y sombras

- `radius` 8px (cards, modales)
- `radiusSm` 5px (botones, inputs, pills, thumbs)
- `radiusLg` 14px (modal grande, hero)
- `shadowCard` `0 1px 0 rgba(28,28,26,0.04)` — bordes finos en vez de sombras
- `shadowPop` `0 12px 32px -12px rgba(28,28,26,0.18), 0 2px 6px rgba(28,28,26,0.06)` — sólo modales/dropdowns

### Iconos

Estilo **Lucide**: SVG 24×24, stroke `1.7`, `stroke-linecap="round"`,
`stroke-linejoin="round"`, sin fill. Tamaño por defecto 18px en botones, 14px
en metadata, 22px en empty states.

---

## 3. Componentes base

Todos en `frontend/src/components/common/`. Si falta uno, **crearlo antes** de
copiar estilos en cada página.

| Componente      | Props clave                                 | Uso |
|-----------------|---------------------------------------------|-----|
| `<Button>`      | `variant=primary\|secondary\|ghost\|danger\|success\|accent`, `size=sm\|md`, `leftIcon`, `rightIcon` | Cualquier botón |
| `<Badge>`       | `tone=primary\|success\|warn\|danger\|accent\|muted`, `dot` | Estados, etiquetas |
| `<Card>`        | `padding`, `style`                          | Contenedor estándar |
| `<Input>`       | `leftIcon`, `rightIcon` + props nativas     | Inputs de texto |
| `<Select>`      | `options=[{value,label}]`, `value`, `onChange` | Dropdowns |
| `<Modal>`       | `open`, `onClose`, `title`, `subtitle`, `footer` | Modales centrados |
| `<ProductThumb>`| `emoji` o `imageUrl`, `size`                | Thumb cuadrado con tinte |
| `<Stat>`        | `label`, `value`, `hint`, `icon`            | KPIs en dashboard |
| `<Tabs>`        | `tabs=[{value,label,count}]`                | Tabs subrayadas |
| `<Toggle>`      | `checked`, `onChange`, `size`               | Switches |
| `<DataTable>`   | (ya existe — adaptar al sistema)            | Tablas con sorting/filters |

Ver `handoff/prototype/src/ui.jsx` para implementación de referencia.

---

## 4. Patrones recurrentes

### Tabla de productos
- Header con bg `surface2`, label uppercase 12px peso 600 color `textMuted`
- Filas con borde superior `border`, hover bg `surface2`
- Primera col: `<ProductThumb>` 36px + nombre 500 + SKU mono 12px abajo
- Precios: `text-align: right`, `tabular-nums`, peso 600 en venta
- Última col: `<Badge>` con `dot` para estado

### Card de alerta de precio
- Header (thumb + nombre + supplier · SKU + delta)
- Body con comparativa "Antes → Ahora" (precio viejo tachado a la izq.,
  nuevo en color `danger` o `success` a la der.)
- Sección "Vinculados a Odoo" en bg `surface2` listando empresas
- Footer con acciones "Descartar" (ghost) + "Aprobar y actualizar Odoo" (primary)

### Filtros de tabla
Card con padding 14px, gap 10px, flex-wrap. Search expandible (`flex: 1 1 280px`),
selects de 140-180px, switches de empresa al final.

### Empty state
Centrado, círculo 48px con icono, título 15px peso 500, descripción 13px muted,
max-width 380px.

### Sidebar
- 240px, `surface` con borde derecho `border`
- Brand arriba (logo cuadrado primary 30px + nombre + tagline)
- Items con icon 17px, label 13px, badge alineado a la derecha
- Items activos: bg `primarySoft`, color `primary`, peso 600
- Secciones separadas con label uppercase 11px tracking 0.06em

---

## 5. Reglas duras (no negociables)

1. **No hardcodear colores ni hex en componentes** — siempre desde `tokens.js`.
2. **No usar emojis decorativos** salvo placeholders de productos.
3. **No mezclar tipografías**. Inter para todo, mono sólo SKUs/códigos.
4. **No usar gradientes** salvo en login y skeletons.
5. **Bordes finos > sombras pesadas**. `shadowCard` es lo más oscuro permitido
   en cards normales.
6. **Tablas siempre con tabular-nums** en columnas numéricas.
7. **Todos los CTA primarios** llevan icono al lado para reforzar la acción.
8. **Voseo siempre**. "Ingresá", "guardá", "tu pedido", nunca "ingrese" ni "tu".

---

## 6. Antes de mergear

Checklist para PRs que tocan UI:

- [ ] ¿Importé desde `tokens.js` o hardcodeé valores?
- [ ] ¿Reusé componentes de `common/` o copié estilos?
- [ ] ¿Las tablas tienen thumb + nombre + SKU mono?
- [ ] ¿Los precios usan `tabular-nums`?
- [ ] ¿Los estados de stock/precios tienen color semántico correcto?
- [ ] ¿Funciona en mobile (sidebar colapsable, tablas scrollables)?
- [ ] ¿La copy es voseo?
- [ ] ¿Probé con tema oscuro?
