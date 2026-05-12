import { useEffect } from 'react';
import { useTheme } from '../../theme/ThemeContext';

const STYLE_ID = 'neggo-spinner-kf';
function injectKeyframes() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = `@keyframes neggo-spin { 0% { transform: rotate(0deg) } 100% { transform: rotate(360deg) } }`;
    document.head.appendChild(tag);
}

const SIZE_MAP   = { sm: 20, md: 36, lg: 52 };
const BORDER_MAP = { sm: 2,  md: 3,  lg: 4  };

export default function LoadingSpinner({ size = 'md', color }) {
    const { tokens: t } = useTheme();
    useEffect(() => { injectKeyframes(); }, []);

    const px     = SIZE_MAP[size]   ?? SIZE_MAP.md;
    const border = BORDER_MAP[size] ?? BORDER_MAP.md;
    const stroke = color ?? t.color.primary;

    return (
        <div
            style={{
                width: px, height: px,
                borderRadius: '50%',
                border: `${border}px solid ${t.color.surface2}`,
                borderTopColor: stroke,
                animation: 'neggo-spin 0.75s linear infinite',
                flexShrink: 0,
            }}
            role="status"
            aria-label="Cargando…"
        />
    );
}
