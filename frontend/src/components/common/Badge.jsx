import { useTheme } from '../../theme/ThemeContext';

export default function Badge({ tone = 'muted', children, dot, style }) {
  const { tokens: t } = useTheme();

  const tones = {
    primary: { bg: t.color.primarySoft, fg: t.color.primary },
    success: { bg: t.color.successSoft, fg: t.color.success },
    warn:    { bg: t.color.warnSoft,    fg: t.color.warn },
    danger:  { bg: t.color.dangerSoft,  fg: t.color.danger },
    accent:  { bg: t.color.accentSoft,  fg: t.color.accent },
    muted:   { bg: t.color.surface2,    fg: t.color.textMuted },
  };

  const { bg, fg } = tones[tone] ?? tones.muted;

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: bg,
      color: fg,
      padding: '3px 9px',
      borderRadius: t.radius.full,
      fontSize: t.font.size.xs,
      fontWeight: t.font.weight.medium,
      lineHeight: 1.4,
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {dot && (
        <span style={{ width: 6, height: 6, borderRadius: t.radius.full, background: fg, flexShrink: 0 }} />
      )}
      {children}
    </span>
  );
}
