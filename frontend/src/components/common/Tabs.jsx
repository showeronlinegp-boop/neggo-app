import { useTheme } from '../../theme/ThemeContext';

export default function Tabs({ tabs = [], value, onChange, style, fullWidth }) {
  const { tokens: t } = useTheme();

  return (
    <div style={{
      display: 'flex',
      gap: fullWidth ? 0 : 4,
      borderBottom: `1px solid ${t.color.border}`,
      ...style,
    }}>
      {tabs.map(tab => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            style={{
              padding: fullWidth ? '10px 6px' : '10px 14px',
              fontSize: t.font.size.sm,
              fontWeight: t.font.weight.medium,
              fontFamily: t.font.family,
              color: active ? t.color.text : t.color.textMuted,
              borderBottom: `2px solid ${active ? t.color.primary : 'transparent'}`,
              marginBottom: -1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: fullWidth ? 'center' : undefined,
              gap: fullWidth ? 5 : 8,
              cursor: 'pointer',
              background: 'transparent',
              transition: 'color 120ms',
              flex: fullWidth ? 1 : undefined,
              minWidth: 0,
            }}
          >
            {tab.icon && (
              <span style={{ display: 'flex', color: active ? t.color.primary : t.color.textMuted, flexShrink: 0 }}>
                {tab.icon}
              </span>
            )}
            {tab.label}
            {tab.count != null && (
              <span style={{
                background: active ? t.color.primarySoft : t.color.surface2,
                color: active ? t.color.primary : t.color.textMuted,
                fontSize: t.font.size.xs,
                padding: '1px 7px',
                borderRadius: t.radius.full,
                fontWeight: t.font.weight.semibold,
              }}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
