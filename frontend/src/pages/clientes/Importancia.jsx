import { useTheme } from '../../theme/ThemeContext';
import { IMPORTANCIA_MAX, IMPORTANCIA_LABEL } from './clientesUi';

// Barrita de importancia (nota #71): cinco cuadraditos de menos a más importante.
// Tocar uno marca hasta ahí; tocar el último marcado lo desmarca (baja uno).
// Sin onChange queda de solo lectura.

export default function Importancia({ value = 0, onChange, disabled = false, size = 14 }) {
    const { tokens: t } = useTheme();
    const nivel = Math.max(0, Math.min(IMPORTANCIA_MAX, Number(value) || 0));
    const editable = Boolean(onChange) && !disabled;
    const titulo = nivel ? `Importancia: ${IMPORTANCIA_LABEL[nivel]}` : 'Sin importancia marcada';

    const elegir = (e, n) => {
        // Dentro de una fila clickeable: que no abra la ficha
        e.stopPropagation();
        if (!editable) return;
        onChange(n === nivel ? n - 1 : n);
    };

    return (
        <span role="group" aria-label={titulo} title={titulo}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
            {Array.from({ length: IMPORTANCIA_MAX }, (_, i) => {
                const n = i + 1;
                const lleno = n <= nivel;
                const cuadro = {
                    width: size, height: size, borderRadius: 3, boxSizing: 'border-box', padding: 0,
                    border: `1px solid ${lleno ? t.color.primary : t.color.borderStrong}`,
                    background: lleno ? t.color.primary : t.color.surface,
                    // Más importante, más intenso
                    opacity: lleno ? 0.45 + (0.55 * n) / IMPORTANCIA_MAX : 1,
                };
                if (!onChange) return <span key={n} aria-hidden="true" style={cuadro} />;
                return (
                    <button key={n} type="button" aria-pressed={lleno} disabled={disabled}
                        aria-label={`Importancia ${n} de ${IMPORTANCIA_MAX}: ${IMPORTANCIA_LABEL[n]}`}
                        onClick={(e) => elegir(e, n)}
                        style={{ ...cuadro, cursor: editable ? 'pointer' : 'default', margin: 0 }} />
                );
            })}
        </span>
    );
}
