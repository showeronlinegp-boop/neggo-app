import { useState } from 'react';
import { useTheme } from '../../theme/ThemeContext';
import { fmtInt } from '../../theme/tokens';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import { resumenBloque } from './cotizacionesNeggo';

// Bloque de arriba de Pendientes (nota 149): clientes de Neggo esperando mercadería
// de cotizaciones «Pendiente» de Odoo. Muestra cuánto falta pedir y lo que ya llegó,
// y deja mandar todo a la cola de una (con confirmación en el mismo botón).

export default function BloqueCotizaciones({ data, loading, error, trabajando, onVer, onVerListas, onReponerTodo, onReponerProveedor, isMobile }) {
    const { tokens: t } = useTheme();
    const [confirmando, setConfirmando] = useState(false);

    if (loading && !data) {
        return (
            <div style={{ ...caja(t, isMobile), color: t.color.textMuted, fontSize: t.font.size.sm }}>
                Leyendo cotizaciones pendientes de Odoo…
            </div>
        );
    }
    if (error && !data) {
        return (
            <div style={{ ...caja(t, isMobile), color: t.color.textMuted, fontSize: t.font.size.sm }}>
                No se pudieron leer las cotizaciones pendientes de Odoo. Tocá «Actualizar» para reintentar.
            </div>
        );
    }
    if (!data) return null;
    const r = resumenBloque(data);
    if (!r.cotizaciones) return null;

    const dato = (n, label, color) => (
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
            <span style={{ fontWeight: t.font.weight.semibold, color: color || t.color.text, ...t.numericStyle }}>{fmtInt(n)}</span>
            <span>{label}</span>
        </span>
    );

    const mandar = async () => {
        if (!confirmando) { setConfirmando(true); return; }
        setConfirmando(false);
        await onReponerTodo();
    };

    return (
        <div style={caja(t, isMobile)}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: t.space[3], flexWrap: 'wrap' }}>
                <span style={{
                    width: 32, height: 32, borderRadius: t.radius.md, flexShrink: 0,
                    background: t.color.accentSoft, color: t.color.accent,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <Icon.Users size={16} />
                </span>
                <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.text }}>
                        Clientes esperando mercadería
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 2 }}>
                        {dato(r.cotizaciones, r.cotizaciones === 1 ? 'cotización' : 'cotizaciones')}
                        {dato(r.sinPedir, 'sin pedir', r.sinPedir ? t.color.accent : undefined)}
                        {r.enCola > 0 && dato(r.enCola, 'en la cola')}
                        {r.encargados > 0 && dato(r.encargados, r.encargados === 1 ? 'encargado' : 'encargados')}
                        {r.llegaron > 0 && dato(r.llegaron, r.llegaron === 1 ? 'ya llegó' : 'ya llegaron', t.color.success)}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', width: isMobile ? '100%' : undefined }}>
                    <Button size="sm" variant="ghost" leftIcon={<Icon.Tag size={13} />} onClick={onVer}
                        style={isMobile ? { flex: 1, height: 40 } : undefined}>
                        Ver cotizaciones
                    </Button>
                    {r.sinPedir > 0 && (
                        <>
                            {confirmando && (
                                <Button size="sm" variant="ghost" onClick={() => setConfirmando(false)}
                                    style={isMobile ? { flex: 1, height: 40 } : undefined}>
                                    Cancelar
                                </Button>
                            )}
                            <Button size="sm" variant={confirmando ? 'accent' : 'primary'} leftIcon={<Icon.Plus size={13} />}
                                disabled={trabajando} onClick={mandar}
                                title="Mete a la cola los productos de Neggo que esperan los clientes y todavía no se pidieron, con la cantidad que pidieron"
                                style={isMobile ? { flex: 1, height: 40 } : undefined}>
                                {trabajando ? 'Mandando…' : confirmando ? `Sí, mandar ${fmtInt(r.sinPedir)} a la cola` : `Mandar todo a reponer (${fmtInt(r.sinPedir)})`}
                            </Button>
                        </>
                    )}
                </div>
            </div>

            {r.proveedores.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2], marginTop: t.space[3], alignItems: 'center' }}>
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Sin pedir por proveedor:</span>
                    {r.proveedores.map(p => (
                        <button key={p.nombre} type="button" disabled={trabajando}
                            onClick={() => onReponerProveedor(p.nombre)}
                            title={`Mandar a la cola lo de ${p.nombre} que esperan los clientes`}
                            style={{
                                border: `1px solid ${t.color.border}`, background: t.color.surface, color: t.color.text,
                                borderRadius: t.radius.full, padding: '0 10px', height: isMobile ? 34 : 26,
                                fontSize: t.font.size.xs, fontFamily: t.font.family, cursor: 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: 6, ...t.numericStyle,
                            }}>
                            <Icon.Plus size={11} />
                            {p.nombre}
                            <span style={{ fontWeight: t.font.weight.semibold }}>{fmtInt(p.n)}</span>
                        </button>
                    ))}
                    {r.otrosProveedores > 0 && (
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                            +{fmtInt(r.otrosProveedores)} proveedor{r.otrosProveedores === 1 ? '' : 'es'}
                        </span>
                    )}
                </div>
            )}

            {r.completas > 0 && (
                <button type="button" onClick={onVerListas} style={{
                    marginTop: t.space[3], width: '100%', textAlign: 'left', cursor: 'pointer',
                    border: 'none', borderRadius: t.radius.sm, padding: '8px 12px',
                    background: t.color.successSoft, color: t.color.success,
                    fontSize: t.font.size.sm, fontFamily: t.font.family, fontWeight: t.font.weight.medium,
                    display: 'flex', alignItems: 'center', gap: 8,
                }}>
                    <Icon.PackageDown size={14} />
                    <span style={{ flex: 1 }}>
                        {r.completas === 1
                            ? '1 cotización ya tiene todo lo que faltaba: avisale al cliente.'
                            : `${fmtInt(r.completas)} cotizaciones ya tienen todo lo que faltaba: avisales a los clientes.`}
                    </span>
                    <Icon.ArrowRight size={14} />
                </button>
            )}
        </div>
    );
}

function caja(t, isMobile) {
    return {
        border: `1px solid ${t.color.border}`,
        borderLeft: `3px solid ${t.color.accent}`,
        borderRadius: t.radius.lg,
        background: t.color.surface,
        padding: isMobile ? '12px' : '14px 16px',
        margin: isMobile ? '0 12px' : undefined,
        fontFamily: t.font.family,
    };
}
