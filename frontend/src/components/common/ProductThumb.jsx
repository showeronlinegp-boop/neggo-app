import { useTheme } from '../../theme/ThemeContext';

export default function ProductThumb({ emoji, imageUrl, size = 44, style }) {
  const { tokens: t } = useTheme();

  const code = (emoji || '?').codePointAt(0) || 0;
  const hue = (code * 47) % 360;

  if (imageUrl) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius: t.radius.sm,
        border: `1px solid ${t.color.border}`,
        overflow: 'hidden',
        flexShrink: 0,
        background: t.color.surface2,
        ...style,
      }}>
        <img
          src={imageUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          onError={e => { e.currentTarget.style.display = 'none'; }}
        />
      </div>
    );
  }

  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: t.radius.sm,
      background: `oklch(0.96 0.02 ${hue})`,
      border: `1px solid ${t.color.border}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: emoji ? size * 0.5 : size * 0.38,
      fontFamily: emoji ? undefined : t.font.family,
      fontWeight: t.font.weight.semibold,
      color: `oklch(0.42 0.06 ${hue})`,
      flexShrink: 0,
      userSelect: 'none',
      ...style,
    }}>
      {emoji || '?'}
    </div>
  );
}
