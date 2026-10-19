import { useEffect } from 'react';
import { useTheme } from '../../theme/ThemeContext';

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

// Panel lateral derecho para editar un registro sin perder de vista la lista.
// Misma API que Modal: isOpen, onClose, title, subtitle, footer.
export default function Drawer({ isOpen, onClose, title, subtitle, children, footer, width = 520 }) {
  const { tokens: t } = useTheme();

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(20,20,18,0.32)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div style={{
        width: '100%',
        maxWidth: width,
        height: '100%',
        background: t.color.surface,
        borderLeft: `1px solid ${t.color.border}`,
        boxShadow: t.shadow.pop,
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '18px 24px',
          borderBottom: `1px solid ${t.color.border}`,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
              {title}
            </div>
            {subtitle && (
              <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4, fontFamily: t.font.family }}>
                {subtitle}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            style={{
              width: 30, height: 30,
              borderRadius: t.radius.sm,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: t.color.textMuted, cursor: 'pointer', background: 'transparent',
              border: 'none', flexShrink: 0,
            }}
          >
            <XIcon />
          </button>
        </div>

        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {children}
        </div>

        {footer && (
          <div style={{
            padding: '14px 24px',
            borderTop: `1px solid ${t.color.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: t.color.surface2,
            flexShrink: 0,
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
