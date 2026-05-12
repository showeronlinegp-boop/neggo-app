import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { getTokens } from './tokens';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    return localStorage.getItem('neggo-theme') || 'light';
  });

  const tokens = useMemo(() => getTokens(theme), [theme]);

  function setTheme(next) {
    const value = next === 'dark' ? 'dark' : 'light';
    localStorage.setItem('neggo-theme', value);
    setThemeState(value);
  }

  // Fondo base del body sincronizado con el tema
  useEffect(() => {
    document.body.style.background = tokens.color.bg;
    document.body.style.color = tokens.color.text;
    document.body.style.fontFamily = tokens.font.family;
  }, [tokens]);

  return (
    <ThemeContext.Provider value={{ tokens, theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme debe usarse dentro de ThemeProvider');
  return ctx;
}
