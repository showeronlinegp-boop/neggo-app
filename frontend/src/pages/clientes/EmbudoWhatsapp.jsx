import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import LeadFicha from './LeadFicha';
import { ETAPA_TONO, haceCuanto } from './etapasWhatsappUi';

// Prospectos (posibles clientes) que tienen chat con el WhatsApp del negocio, en columnas por etapa.
// Cada columna dice su objetivo: cumplirlo es lo que lo pasa a la siguiente.
export default function EmbudoWhatsapp({ onCambio }) {
    const { tokens: t } = useTheme();
    const [datos, setDatos] = useState(null);
    const [error, setError] = useState(null);
    const [soloEsperan, setSoloEsperan] = useState(false);
    const [abierto, setAbierto] = useState(null);
    const huboCambios = useRef(false);

    const cargar = useCallback(async () => {
        const res = await api.get('/clientes/leads/whatsapp-embudo');
        if (!res.success) { setError(res.error || 'No se pudo cargar el embudo'); return; }
        setError(null);
        setDatos(res.data);
    }, []);
    useEffect(() => { cargar(); }, [cargar]);

    const cerrarFicha = () => {
        setAbierto(null);
        if (huboCambios.current) { huboCambios.current = false; cargar(); onCambio?.(); }
    };

    const columnas = (datos?.etapas || []).map((g) => ({
        ...g, items: soloEsperan ? g.items.filter((i) => i.espera_respuesta) : g.items,
    }));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6], fontFamily: t.font.family }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap' }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, maxWidth: 640 }}>
                    Prospectos que hablan con el WhatsApp del negocio. La etapa se mueve sola según quién escribió último
                    y lo que informa Grok; <strong>Interesado</strong> y <strong>Descartado</strong> los marcás vos desde la ficha.
                </div>
                {datos && (
                    <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                        <Button size="sm" variant={soloEsperan ? 'primary' : 'secondary'} onClick={() => setSoloEsperan((v) => !v)}>
                            {`Te escribieron y esperan respuesta · ${fmtInt(datos.espera_respuesta)}`}
                        </Button>
                        <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={14} />} onClick={cargar}>Actualizar</Button>
                    </div>
                )}
            </div>

            {error && <div role="alert" style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}
            {!datos && !error && <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Cargando…</div>}
            {datos && datos.total === 0 && (
                <Card>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                        Todavía no hay prospectos con chat. El cruce con el WhatsApp del negocio corre cada 15 minutos.
                    </div>
                </Card>
            )}

            {datos && datos.total > 0 && (
                <div style={{ overflowX: 'auto', paddingBottom: t.space[2] }}>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columnas.length}, minmax(210px, 1fr))`, gap: t.space[4], minWidth: columnas.length * 220 }}>
                        {columnas.map((g) => (
                            <div key={g.id} style={{
                                background: t.color.surface2, borderRadius: t.radius.md, padding: t.space[4],
                                display: 'flex', flexDirection: 'column', gap: t.space[3], minWidth: 0,
                            }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[2] }}>
                                        <Badge tone={ETAPA_TONO[g.id]} dot>{g.label}</Badge>
                                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>{fmtInt(g.items.length)}</span>
                                    </div>
                                    {g.objetivo && (
                                        <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>Objetivo: {g.objetivo}</span>
                                    )}
                                </div>
                                {g.items.map((l) => (
                                    <button key={l.id} type="button" onClick={() => setAbierto(l)} style={{
                                        textAlign: 'left', cursor: 'pointer', background: t.color.surface,
                                        border: `1px solid ${l.espera_respuesta ? t.color.accent : t.color.border}`,
                                        borderRadius: t.radius.sm, padding: t.space[3], fontFamily: t.font.family,
                                        display: 'flex', flexDirection: 'column', gap: 4,
                                    }}>
                                        <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text }}>
                                            {l.name || 'Sin nombre'}
                                        </span>
                                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.mono }}>
                                            {[l.phone, l.city].filter(Boolean).join(' · ')}
                                        </span>
                                        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                            {l.espera_respuesta && <Badge tone="accent">{`Te escribió ${haceCuanto(l.ultimo_mensaje_at)}`}</Badge>}
                                            {!l.espera_respuesta && l.ultimo_mensaje_at && (
                                                <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>Último mensaje {haceCuanto(l.ultimo_mensaje_at)}</span>
                                            )}
                                            {l.entro_por_whatsapp && <Badge tone="muted">Nuevo por WhatsApp</Badge>}
                                            {l.manual && <Badge tone="muted">Marcada a mano</Badge>}
                                        </span>
                                    </button>
                                ))}
                                {!g.items.length && <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>Nadie en esta etapa</span>}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <LeadFicha leadId={abierto?.id} resumen={abierto} onClose={cerrarFicha} onCambio={() => { huboCambios.current = true; }} />
        </div>
    );
}
