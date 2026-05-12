// Componentes UI compartidos: Button, Badge, Card, Input, Select, Modal, etc.

const Button = ({ variant = 'secondary', size = 'md', children, leftIcon, rightIcon, style, ...rest }) => {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontWeight: 500, borderRadius: 'var(--radius-sm)',
    transition: 'all 120ms ease',
    whiteSpace: 'nowrap',
    border: '1px solid transparent',
    fontSize: size === 'sm' ? 'var(--font-sm)' : 'var(--font-base)',
    height: size === 'sm' ? 32 : 38,
    padding: size === 'sm' ? '0 12px' : '0 16px',
    lineHeight: 1,
  };
  const variants = {
    primary: { background: 'var(--primary)', color: '#fff' },
    secondary: { background: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border-strong)' },
    ghost: { background: 'transparent', color: 'var(--text-muted)' },
    danger: { background: 'var(--surface)', color: 'var(--danger)', borderColor: 'var(--border-strong)' },
    success: { background: 'var(--success)', color: '#fff' },
    accent: { background: 'var(--accent)', color: '#fff' },
  };
  const [hover, setHover] = React.useState(false);
  const hovered = hover ? {
    primary: { background: 'var(--primary-hover)' },
    secondary: { background: 'var(--surface-2)' },
    ghost: { background: 'var(--surface-2)', color: 'var(--text)' },
    danger: { background: 'var(--danger-soft)' },
    success: { filter: 'brightness(0.92)' },
    accent: { filter: 'brightness(0.92)' },
  }[variant] : {};
  return (
    <button {...rest}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...base, ...variants[variant], ...hovered, ...style }}>
      {leftIcon}{children}{rightIcon}
    </button>
  );
};

const Badge = ({ tone = 'muted', children, dot, style }) => {
  const tones = {
    primary: { bg: 'var(--primary-soft)', fg: 'var(--primary)' },
    success: { bg: 'var(--success-soft)', fg: 'var(--success)' },
    warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)' },
    danger: { bg: 'var(--danger-soft)', fg: 'var(--danger)' },
    accent: { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
    muted: { bg: 'var(--surface-2)', fg: 'var(--text-muted)' },
  };
  const t = tones[tone] || tones.muted;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: t.bg, color: t.fg,
      padding: '3px 9px', borderRadius: 999,
      fontSize: 'var(--font-xs)', fontWeight: 500,
      lineHeight: 1.4, whiteSpace: 'nowrap',
      ...style,
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 999, background: t.fg }} />}
      {children}
    </span>
  );
};

const Card = ({ children, padding = true, style, ...rest }) => (
  <div {...rest} style={{
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-card)',
    padding: padding ? 'var(--pad-y) var(--pad-x)' : 0,
    ...style,
  }}>
    {children}
  </div>
);

const Input = ({ leftIcon, rightIcon, style, ...rest }) => {
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      background: 'var(--surface)',
      border: `1px solid ${focus ? 'var(--primary)' : 'var(--border-strong)'}`,
      borderRadius: 'var(--radius-sm)',
      padding: '0 12px', height: 38,
      transition: 'border-color 120ms',
      boxShadow: focus ? '0 0 0 3px var(--primary-soft)' : 'none',
      ...style,
    }}>
      {leftIcon && <span style={{ color: 'var(--text-faint)', marginRight: 8, display: 'flex' }}>{leftIcon}</span>}
      <input {...rest}
        onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
        style={{
          border: 'none', outline: 'none', background: 'transparent',
          flex: 1, height: '100%', color: 'var(--text)',
          fontSize: 'var(--font-base)',
        }} />
      {rightIcon && <span style={{ color: 'var(--text-faint)', marginLeft: 8, display: 'flex' }}>{rightIcon}</span>}
    </div>
  );
};

const Select = ({ value, onChange, options, placeholder, style }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const current = options.find(o => o.value === value);
  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', height: 38, padding: '0 12px',
        background: 'var(--surface)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-sm)',
        color: current ? 'var(--text)' : 'var(--text-faint)',
        fontSize: 'var(--font-base)', gap: 8,
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{current ? current.label : placeholder}</span>
        <Icons.ChevDown size={14} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-pop)',
          zIndex: 50, maxHeight: 280, overflow: 'auto',
        }}>
          {options.map(o => (
            <button key={o.value} onClick={() => { onChange(o.value); setOpen(false); }} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', padding: '9px 12px', textAlign: 'left',
              fontSize: 'var(--font-base)',
              background: o.value === value ? 'var(--surface-2)' : 'transparent',
              color: 'var(--text)',
            }}
              onMouseEnter={(e) => { if (o.value !== value) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { if (o.value !== value) e.currentTarget.style.background = 'transparent'; }}
            >
              <span>{o.label}</span>
              {o.value === value && <Icons.Check size={14} stroke="var(--primary)" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const Modal = ({ open, onClose, children, width = 560, title, subtitle, footer }) => {
  React.useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    if (open) document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(20,20,18,0.42)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '8vh 16px',
      animation: 'fadeIn 180ms ease',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: width,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-pop)',
        overflow: 'hidden',
        animation: 'popIn 200ms ease',
      }}>
        {(title || subtitle) && (
          <div style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
          }}>
            <div>
              {title && <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)' }}>{title}</div>}
              {subtitle && <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', marginTop: 4 }}>{subtitle}</div>}
            </div>
            <button onClick={onClose} style={{
              width: 30, height: 30, borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)',
            }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            ><Icons.X size={16} /></button>
          </div>
        )}
        <div style={{ padding: '20px 24px', maxHeight: '70vh', overflow: 'auto' }}>{children}</div>
        {footer && (
          <div style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border)',
            display: 'flex', justifyContent: 'flex-end', gap: 10,
            background: 'var(--surface-2)',
          }}>{footer}</div>
        )}
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes popIn { from { opacity: 0; transform: translateY(-8px) scale(.98) } to { opacity: 1; transform: none } }
      `}</style>
    </div>
  );
};

// Visual placeholder for product image — emoji on tinted bg
const ProductThumb = ({ emoji, size = 44, rounded = 'var(--radius-sm)' }) => {
  // Deterministic tint based on emoji
  const code = (emoji || '?').codePointAt(0) || 0;
  const hue = (code * 47) % 360;
  return (
    <div style={{
      width: size, height: size, borderRadius: rounded,
      background: `oklch(0.96 0.02 ${hue})`,
      border: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.5, flexShrink: 0,
    }}>{emoji}</div>
  );
};

const Stat = ({ label, value, hint, tone = 'default', icon }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>
      {icon}
      <span>{label}</span>
    </div>
    <div className="num" style={{
      fontSize: 28, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-0.02em',
      color: tone === 'accent' ? 'var(--accent)' : 'var(--text)',
    }}>{value}</div>
    {hint && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-faint)' }}>{hint}</div>}
  </div>
);

const Divider = ({ vertical, style }) => (
  <div style={{
    background: 'var(--border)',
    ...(vertical ? { width: 1, alignSelf: 'stretch' } : { height: 1, width: '100%' }),
    ...style,
  }} />
);

// Toggle pill switch
const Toggle = ({ checked, onChange, size = 'md' }) => {
  const w = size === 'sm' ? 32 : 38;
  const h = size === 'sm' ? 18 : 22;
  return (
    <button onClick={() => onChange(!checked)} style={{
      width: w, height: h, borderRadius: 999,
      background: checked ? 'var(--primary)' : 'var(--border-strong)',
      position: 'relative', transition: 'background 160ms',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: checked ? w - h + 2 : 2,
        width: h - 4, height: h - 4, borderRadius: 999,
        background: '#fff', transition: 'left 160ms',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      }} />
    </button>
  );
};

// Tabs
const Tabs = ({ tabs, value, onChange }) => (
  <div style={{
    display: 'flex', gap: 4,
    borderBottom: '1px solid var(--border)',
  }}>
    {tabs.map(t => {
      const active = t.value === value;
      return (
        <button key={t.value} onClick={() => onChange(t.value)} style={{
          padding: '10px 14px', fontSize: 'var(--font-sm)', fontWeight: 500,
          color: active ? 'var(--text)' : 'var(--text-muted)',
          borderBottom: `2px solid ${active ? 'var(--primary)' : 'transparent'}`,
          marginBottom: -1, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {t.label}
          {t.count != null && (
            <span style={{
              background: active ? 'var(--primary-soft)' : 'var(--surface-2)',
              color: active ? 'var(--primary)' : 'var(--text-muted)',
              fontSize: 'var(--font-xs)', padding: '1px 7px', borderRadius: 999, fontWeight: 600,
            }}>{t.count}</span>
          )}
        </button>
      );
    })}
  </div>
);

Object.assign(window, {
  Button, Badge, Card, Input, Select, Modal, ProductThumb, Stat, Divider, Toggle, Tabs,
});
