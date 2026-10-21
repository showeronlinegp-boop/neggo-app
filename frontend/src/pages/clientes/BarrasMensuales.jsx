import { useState } from 'react';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import { fmtMes } from './clientesUi';

// Facturación por mes de un cliente (una sola serie, sin leyenda: el título la nombra).
// compacto = mini gráfico para la fila del listado (tooltip nativo por barra).
// Completo = barras con meses en el eje y tooltip al pasar el mouse o tocar.
export default function BarrasMensuales({ data = [], compacto = false, alto }) {
    const { tokens: t } = useTheme();
    const [hover, setHover] = useState(null);

    const width = compacto ? 60 : 480;
    const height = alto || (compacto ? 24 : 120);
    const gap = 2;
    const n = data.length || 1;
    const barW = Math.max(2, (width - gap * (n - 1)) / n);
    const max = Math.max(...data.map((d) => Number(d.amount) || 0), 0);
    const radio = Math.min(compacto ? 1.5 : 4, barW / 2);

    // Barra con las puntas de arriba redondeadas, apoyada en la base
    const barPath = (x, h) => {
        const y = height - h;
        const r = Math.min(radio, h);
        return `M${x},${height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${height} Z`;
    };

    const barras = data.map((d, i) => {
        const amount = Number(d.amount) || 0;
        const h = max > 0 ? Math.max(amount > 0 ? 2 : 0, (amount / max) * (height - (compacto ? 0 : 4))) : 0;
        return { ...d, amount, x: i * (barW + gap), h };
    });

    const activo = hover != null ? barras[hover] : null;

    return (
        <div style={{ position: 'relative', width: compacto ? width : '100%', fontFamily: t.font.family }}>
            <svg
                viewBox={`0 0 ${width} ${height}`}
                width={compacto ? width : '100%'}
                height={height}
                preserveAspectRatio="none"
                role="img"
                aria-label={`Facturación de los últimos ${data.length} meses`}
                style={{ display: 'block', overflow: 'visible' }}
                onMouseLeave={() => setHover(null)}
            >
                <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} stroke={t.color.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
                {barras.map((b, i) => (
                    <g key={b.month}>
                        {b.h > 0 && (
                            <path
                                d={barPath(b.x, b.h)}
                                fill={hover === i || hover == null ? t.color.primary : t.color.primarySoft}
                            />
                        )}
                        {/* Zona de toque más grande que la barra */}
                        <rect
                            x={b.x - gap / 2}
                            y={0}
                            width={barW + gap}
                            height={height}
                            fill="transparent"
                            onMouseEnter={() => !compacto && setHover(i)}
                            onClick={() => !compacto && setHover(i)}
                        >
                            {compacto && <title>{`${fmtMes(b.month)}: ${fmtAR(b.amount)}`}</title>}
                        </rect>
                    </g>
                ))}
            </svg>

            {!compacto && (
                <div style={{
                    display: 'flex', justifyContent: 'space-between', marginTop: 6,
                    fontSize: t.font.size.xs, color: t.color.textFaint, ...t.numericStyle,
                }}>
                    <span>{data[0] ? fmtMes(data[0].month) : ''}</span>
                    <span>{data.length ? fmtMes(data[data.length - 1].month) : ''}</span>
                </div>
            )}

            {!compacto && activo && (
                <div style={{
                    position: 'absolute', top: -8, transform: 'translate(-50%, -100%)',
                    // Entre 12% y 88% para que el tooltip no se corte en los bordes
                    left: `${Math.min(88, Math.max(12, ((activo.x + barW / 2) / width) * 100))}%`,
                    background: t.color.surface, border: `1px solid ${t.color.border}`,
                    borderRadius: t.radius.sm, boxShadow: t.shadow.pop, padding: '6px 10px',
                    fontSize: t.font.size.xs, color: t.color.text, whiteSpace: 'nowrap',
                    pointerEvents: 'none', ...t.numericStyle,
                }}>
                    <div style={{ color: t.color.textMuted }}>{fmtMes(activo.month)}</div>
                    <div style={{ fontWeight: t.font.weight.semibold }}>{fmtAR(activo.amount)}</div>
                </div>
            )}
        </div>
    );
}
