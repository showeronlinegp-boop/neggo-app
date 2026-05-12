import { useState } from 'react';
import { useTheme } from '../../theme/ThemeContext';

export default function Button({
  variant = 'secondary',
  size = 'md',
  children,
  leftIcon,
  rightIcon,
  style,
  disabled,
  ...rest
}) {
  const { tokens: t } = useTheme();
  const [hover, setHover] = useState(false);

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontFamily: t.font.family,
    fontWeight: t.font.weight.medium,
    borderRadius: t.radius.sm,
    border: '1px solid transparent',
    whiteSpace: 'nowrap',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 120ms ease',
    lineHeight: 1,
    opacity: disabled ? 0.5 : 1,
    fontSize: size === 'sm' ? t.font.size.sm : t.font.size.base,
    height: size === 'sm' ? t.layout.buttonHeight.sm : t.layout.buttonHeight.md,
    padding: size === 'sm' ? '0 12px' : '0 16px',
  };

  const variants = {
    primary: {
      background: hover ? t.color.primaryHover : t.color.primary,
      color: '#fff',
    },
    secondary: {
      background: hover ? t.color.surface2 : t.color.surface,
      color: t.color.text,
      borderColor: t.color.borderStrong,
    },
    ghost: {
      background: hover ? t.color.surface2 : 'transparent',
      color: hover ? t.color.text : t.color.textMuted,
    },
    danger: {
      background: hover ? t.color.dangerSoft : t.color.surface,
      color: t.color.danger,
      borderColor: t.color.borderStrong,
    },
    success: {
      background: t.color.success,
      color: '#fff',
      filter: hover ? 'brightness(0.92)' : 'none',
    },
    accent: {
      background: t.color.accent,
      color: '#fff',
      filter: hover ? 'brightness(0.92)' : 'none',
    },
  };

  return (
    <button
      {...rest}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}
