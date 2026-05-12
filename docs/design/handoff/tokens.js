// frontend/src/theme/tokens.js
// Sistema de diseño Neggo — fuente única de verdad.
// Importar desde acá en TODO componente. Nunca hardcodear.

const palette = {
  light: {
    bg: '#fbfaf7',
    surface: '#ffffff',
    surface2: '#f5f3ee',
    border: '#e8e3d8',
    borderStrong: '#d8d2c2',
    text: '#1c1c1a',
    textMuted: '#6b6a64',
    textFaint: '#9a988f',
    primary: '#1f3a68',
    primaryHover: '#162a4d',
    primarySoft: '#eaf0f9',
    accent: '#e25a1c',
    accentSoft: '#fdeee3',
    success: '#2f7a47',
    successSoft: '#e6f1e9',
    warn: '#b8740d',
    warnSoft: '#fbf0d9',
    danger: '#b53a2a',
    dangerSoft: '#fbe5e1',
  },
  dark: {
    bg: '#131311',
    surface: '#1c1c1a',
    surface2: '#232321',
    border: '#2e2e2b',
    borderStrong: '#3a3a36',
    text: '#f0eee6',
    textMuted: '#a4a299',
    textFaint: '#6a6962',
    primary: '#6ea0e8',
    primaryHover: '#8ab2ee',
    primarySoft: '#1b2638',
    accent: '#ff8147',
    accentSoft: '#2a1a10',
    success: '#3ea05c',
    successSoft: '#142a1b',
    warn: '#d99124',
    warnSoft: '#2a1f0c',
    danger: '#d65a47',
    dangerSoft: '#2a140f',
  },
};

const font = {
  family: "'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  size: { xs: 12, sm: 13, base: 14, lg: 16, xl: 22, '2xl': 28 },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
};

const space = { 1: 4, 2: 8, 3: 10, 4: 12, 5: 14, 6: 16, 8: 20, 10: 24, 12: 32, 16: 48 };

const radius = { sm: 5, md: 8, lg: 14, full: 999 };

const shadow = {
  card: '0 1px 0 rgba(28,28,26,0.04)',
  pop: '0 12px 32px -12px rgba(28,28,26,0.18), 0 2px 6px rgba(28,28,26,0.06)',
};

const layout = {
  sidebarWidth: 240,
  rowHeight: 44,
  cardPadX: 28,
  cardPadY: 22,
  inputHeight: 38,
  buttonHeight: { sm: 32, md: 38 },
};

// Utilidad: usar siempre en columnas numéricas y precios
const numericStyle = { fontVariantNumeric: 'tabular-nums' };

// Helper para obtener tokens según tema activo
function getTokens(theme = 'light') {
  return {
    color: palette[theme],
    font,
    space,
    radius,
    shadow,
    layout,
    numericStyle,
  };
}

// Format helpers (centralizados acá para que toda la app formatee igual)
const fmtAR = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
const fmtPct = (n) => (n > 0 ? '+' : '') + (Number(n) || 0).toFixed(1) + '%';
const fmtInt = (n) => (Number(n) || 0).toLocaleString('es-AR');

module.exports = {
  palette, font, space, radius, shadow, layout, numericStyle,
  getTokens, fmtAR, fmtPct, fmtInt,
};

// Si el proyecto usa ESM (Vite default), también exportar como ESM:
// export { palette, font, space, radius, shadow, layout, numericStyle, getTokens, fmtAR, fmtPct, fmtInt };
