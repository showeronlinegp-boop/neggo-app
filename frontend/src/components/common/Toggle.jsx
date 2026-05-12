import { useTheme } from '../../theme/ThemeContext';

export default function Toggle({ checked, onChange, size = 'md', disabled, style }) {
  const { tokens: t } = useTheme();

  const w = size === 'sm' ? 32 : 38;
  const h = size === 'sm' ? 18 : 22;

  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: w,
        height: h,
        borderRadius: t.radius.full,
        background: checked ? t.color.primary : t.color.borderStrong,
        position: 'relative',
        transition: 'background 160ms',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
        ...style,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: checked ? w - h + 2 : 2,
        width: h - 4,
        height: h - 4,
        borderRadius: t.radius.full,
        background: '#fff',
        transition: 'left 160ms',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      }} />
    </button>
  );
}
