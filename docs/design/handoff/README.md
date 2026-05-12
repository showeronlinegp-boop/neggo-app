# Handoff — Neggo Design System

Paquete listo para llevar a tu repo `neggo-app/` y entregarle a Claude Code.

## Contenido

```
handoff/
├── README.md                  ← Estás acá
├── DESIGN_SYSTEM.md           ← Sistema completo (tokens, componentes, reglas)
├── tokens.js                  ← Fuente única de tokens, listos para usar
├── CLAUDE_CODE_PROMPT.md      ← Prompt paso a paso para Claude Code
└── prototype/                 ← El prototipo aprobado, como referencia visual
    ├── Neggo App.html
    └── src/                   ← Componentes React de referencia
```

## Cómo usarlo

### 1. Copiar a tu repo

Movelo todo a `neggo-app/docs/design/`:

```
neggo-app/docs/design/
├── DESIGN_SYSTEM.md
├── tokens.js
├── CLAUDE_CODE_PROMPT.md
└── prototype/
    ├── Neggo App.html
    └── src/...
```

### 2. Agregar al CLAUDE.md del repo

Sumá esta sección al final de `neggo-app/CLAUDE.md`:

```markdown
## Lenguaje de diseño

Antes de tocar UI, leé `docs/design/DESIGN_SYSTEM.md`. Importá tokens desde
`frontend/src/theme/tokens.js` (copiar de `docs/design/tokens.js` si todavía
no está). Mirá el prototipo en `docs/design/prototype/Neggo App.html` cuando
necesites referencia visual.

Reglas duras: no hardcodear colores, no mezclar tipografías, voseo en toda
la UI, tablas con thumb + nombre + SKU mono debajo, precios con tabular-nums.
```

### 3. Arrancar Claude Code

Abrí Claude Code en el repo y pegale el contenido de `CLAUDE_CODE_PROMPT.md`
como primer mensaje. Está armado para que trabaje en pasos chicos y
verificables — no le pidas todo de una.

## Tip

Si ves que Claude Code "olvida" el sistema mid-refactor, recordáselo así:

> Antes de seguir, releé docs/design/DESIGN_SYSTEM.md sección "Reglas duras"
> y verificá que los últimos cambios cumplen.
