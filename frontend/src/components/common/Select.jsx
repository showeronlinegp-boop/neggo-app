import { useState, useRef, useEffect } from 'react';
import { useTheme } from '../../theme/ThemeContext';

function ChevDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M3 5l4 4 4-4" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M2.5 7l3.5 3.5 5.5-6" />
    </svg>
  );
}

export default function Select({ value, onChange, options = [], placeholder = 'Seleccioná...', style }) {
  const { tokens: t } = useTheme();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const current = options.find(o => o.value === value);

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          height: t.layout.inputHeight,
          padding: '0 12px',
          background: t.color.surface,
          border: `1px solid ${t.color.borderStrong}`,
          borderRadius: t.radius.sm,
          color: current ? t.color.text : t.color.textFaint,
          fontSize: t.font.size.base,
          fontFamily: t.font.family,
          cursor: 'pointer',
          gap: 8,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>
          {current ? current.label : placeholder}
        </span>
        <span style={{ color: t.color.textMuted, flexShrink: 0 }}><ChevDown /></span>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          right: 0,
          background: t.color.surface,
          border: `1px solid ${t.color.border}`,
          borderRadius: t.radius.sm,
          boxShadow: t.shadow.pop,
          zIndex: 50,
          maxHeight: 280,
          overflowY: 'auto',
        }}>
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              onMouseEnter={() => setHovered(o.value)}
              onMouseLeave={() => setHovered(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '9px 12px',
                textAlign: 'left',
                fontSize: t.font.size.base,
                fontFamily: t.font.family,
                background: o.value === value || hovered === o.value ? t.color.surface2 : 'transparent',
                color: t.color.text,
                cursor: 'pointer',
              }}
            >
              <span>{o.label}</span>
              {o.value === value && (
                <span style={{ color: t.color.primary }}><Check /></span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
