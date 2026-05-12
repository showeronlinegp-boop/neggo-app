import { useTheme } from '../../theme/ThemeContext';

export default function Card({ children, padding = true, style, ...rest }) {
  const { tokens: t } = useTheme();

  return (
    <div
      {...rest}
      style={{
        background: t.color.surface,
        border: `1px solid ${t.color.border}`,
        borderRadius: t.radius.md,
        boxShadow: t.shadow.card,
        padding: padding
          ? `${t.layout.cardPadY}px ${t.layout.cardPadX}px`
          : 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
