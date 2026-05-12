import { useEffect } from 'react';
import { useTheme } from '../../theme/ThemeContext';
import { useDraggable } from '../../hooks/useDraggable';

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

// isOpen es el prop canónico (compatibilidad con callers existentes).
// open es alias por si se usa la API nueva del prototipo.
export default function Modal({
  isOpen,
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 560,
  size,
}) {
  const { tokens: t } = useTheme();
  const visible = isOpen ?? open ?? false;

  // Mapeo del prop `size` viejo a width numérico
  const sizeMap = { sm: 400, md: 560, lg: 900, xl: 1140 };
  const maxWidth = size ? sizeMap[size] ?? 560 : width;

  const { onDragStart, dragStyle, containerStyle, overlayStyle } = useDraggable(visible);

  useEffect(() => {
    if (!visible) return;
    const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  useEffect(() => {
    document.body.style.overflow = visible ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [visible]);

  if (!visible) return null;

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
        background: 'rgba(20,20,18,0.42)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '8vh 16px',
        ...overlayStyle,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: maxWidth,
          background: t.color.surface,
          border: `1px solid ${t.color.border}`,
          borderRadius: t.radius.lg,
          boxShadow: t.shadow.pop,
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
          overflow: 'hidden',
          ...containerStyle,
        }}
      >
        {(title || subtitle) && (
          <div
            onMouseDown={onDragStart}
            style={{
              padding: '20px 24px',
              borderBottom: `1px solid ${t.color.border}`,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
              flexShrink: 0,
              ...dragStyle,
            }}
          >
            <div>
              {title && (
                <div style={{ fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text }}>
                  {title}
                </div>
              )}
              {subtitle && (
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                  {subtitle}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              style={{
                width: 30,
                height: 30,
                borderRadius: t.radius.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: t.color.textMuted,
                cursor: 'pointer',
                background: 'transparent',
                flexShrink: 0,
              }}
            >
              <XIcon />
            </button>
          </div>
        )}

        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {children}
        </div>

        {footer && (
          <div style={{
            padding: '14px 24px',
            borderTop: `1px solid ${t.color.border}`,
            display: 'flex',
            justifyContent: 'flex-end',
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
