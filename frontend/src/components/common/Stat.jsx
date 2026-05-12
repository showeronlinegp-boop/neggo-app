import { useTheme } from '../../theme/ThemeContext';

export default function Stat({ label, value, hint, tone = 'default', icon, style }) {
  const { tokens: t } = useTheme();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: t.color.textMuted,
        fontSize: t.font.size.sm,
      }}>
        {icon}
        <span>{label}</span>
      </div>
      <div style={{
        fontSize: t.font.size['2xl'],
        fontWeight: t.font.weight.semibold,
        lineHeight: 1.1,
        letterSpacing: '-0.02em',
        color: tone === 'accent' ? t.color.accent : t.color.text,
        ...t.numericStyle,
      }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>
          {hint}
        </div>
      )}
    </div>
  );
}
