import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Toggle from '../../components/common/Toggle';
import * as Icon from '../../components/common/icons';
import ClienteFicha from './ClienteFicha';
import LeadFicha from './LeadFicha';
import {
    ACTION_META, STAGE_META, HEALTH_META, fmtProxima, fmtFecha, linkWhatsApp, nombreLead,
} from './clientesUi';

// Mi día (fase 2): acciones de seguimiento vencidas, de hoy y de mañana.
// Todos son responsables de todo (D8): por defecto muestra las de todos.

function Accion({ a, onAbrir, isMobile, t }) {
    const wa = a.phone ? linkWhatsApp(a.phone) : null;
    const etapa = STAGE_META[a.stage] || STAGE_META.frio;
    const salud = a.tipo === 'cliente' ? HEALTH_META[a.health] : null;
    return (
        <div style={{
            display: 'flex', gap: t.space[4], alignItems: isMobile ? 'flex-start' : 'center',
            flexDirection: isMobile ? 'column' : 'row',
            padding: '12px 16px', borderTop: `1px solid ${t.color.border}`,
        }}>
            <button type="button" onClick={() => onAbrir(a)}
                style={{
                    flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: 0,
                    textAlign: 'left', cursor: 'pointer', fontFamily: t.font.family,
                }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2], alignItems: 'center' }}>
                    <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text }}>
                        {ACTION_META[a.action_type]?.label || a.action_type}
                    </span>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.text }}>· {nombreLead(a)}</span>
                    <Badge tone={a.tipo === 'lead' ? 'accent' : 'primary'}>{a.tipo === 'lead' ? 'Posible cliente' : 'Cliente'}</Badge>
                    <Badge tone={etapa.tone}>{etapa.label}</Badge>
                    {salud && <Badge tone={salud.tone} dot>{salud.label}</Badge>}
                </div>
                {a.note && <div style={{ fontSize: t.font.size.sm, color: t.color.text, marginTop: 4 }}>{a.note}</div>}
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '0 10px', ...t.numericStyle }}>
                    <span>{fmtProxima(a.due_date)} · {fmtFecha(a.due_date)}</span>
                    {a.phone && <span style={{ fontFamily: t.font.mono }}>{a.phone}</span>}
                    {a.city && <span>{a.city}</span>}
                    {a.created_by_name && <span>La programó {a.created_by_name}</span>}
                </div>
            </button>
            <div style={{ display: 'flex', gap: t.space[2], flexShrink: 0 }}>
                {wa && (
                    <a href={wa} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                        <Button size="sm" variant="secondary" leftIcon={<Icon.MessageCircle size={14} />}>WhatsApp</Button>
                    </a>
                )}
                <Button size="sm" variant="primary" rightIcon={<Icon.ArrowRight size={14} />} onClick={() => onAbrir(a)}>Abrir</Button>
            </div>
        </div>
    );
}

function Grupo({ titulo, tono, items, onAbrir, isMobile, t }) {
    if (!items.length) return null;
    return (
        <Card padding={false} style={{ overflow: 'hidden', marginBottom: t.space[6] }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: t.space[2], padding: '10px 16px', background: t.color.surface2,
                fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: tono || t.color.textMuted,
                textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>
                {titulo}
                <span style={{ ...t.numericStyle }}>· {fmtInt(items.length)}</span>
            </div>
            {items.map((a) => <Accion key={a.id} a={a} onAbrir={onAbrir} isMobile={isMobile} t={t} />)}
        </Card>
    );
}

export default function MiDia() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [mias, setMias] = useState(false);
    const [abierto, setAbierto] = useState(null);
    const huboCambios = useRef(false);

    const cargar = useCallback(async () => {
        const res = await api.get('/clientes/mi-dia', { mias: mias ? 1 : undefined });
        if (!res.success) { setError(res.error || 'No se pudo cargar Mi día'); return; }
        setError(null);
        setData(res.data);
    }, [mias]);

    useEffect(() => { cargar(); }, [cargar]);

    const cerrar = () => {
        setAbierto(null);
        if (huboCambios.current) { huboCambios.current = false; cargar(); }
    };
    const marcar = () => { huboCambios.current = true; };

    const pendientes = data ? data.vencidas.length + data.hoy.length + data.manana.length : 0;

    return (
        <div style={{ padding: isMobile ? 12 : `${t.layout.cardPadY}px ${t.layout.cardPadX}px`, maxWidth: 1000, margin: '0 auto', fontFamily: t.font.family }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: isMobile ? 22 : t.font.size['2xl'], fontWeight: t.font.weight.semibold, color: t.color.text, letterSpacing: '-0.02em' }}>
                        Mi día
                    </h1>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4, ...t.numericStyle }}>
                        {data
                            ? `${fmtInt(data.hechas_hoy)} hecha${data.hechas_hoy === 1 ? '' : 's'} hoy · ${fmtInt(data.proximas)} programada${data.proximas === 1 ? '' : 's'} para más adelante`
                            : 'Las llamadas, mensajes y visitas que hay que hacer.'}
                    </div>
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: t.font.size.sm, color: t.color.text, cursor: 'pointer' }}>
                    <Toggle checked={mias} onChange={setMias} />
                    Solo las que programé yo
                </label>
            </div>

            {error && (
                <div role="alert" style={{
                    marginBottom: t.space[4], padding: '10px 14px', borderRadius: t.radius.md,
                    background: t.color.dangerSoft, color: t.color.danger, fontSize: t.font.size.sm,
                }}>
                    {error}
                </div>
            )}

            {!data && !error && <div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted, fontSize: t.font.size.sm }}>Cargando…</div>}

            {data && pendientes === 0 && (
                <Card style={{ textAlign: 'center', padding: 40 }}>
                    <div style={{ width: 48, height: 48, borderRadius: '50%', background: t.color.successSoft, color: t.color.success, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                        <Icon.Check size={22} />
                    </div>
                    <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text }}>No hay nada pendiente para hoy ni mañana</div>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                        Programá acciones desde la ficha de cada cliente, en Ventas → Clientes.
                    </div>
                </Card>
            )}

            {data && (
                <>
                    <Grupo titulo="Vencidas" tono={t.color.danger} items={data.vencidas} onAbrir={setAbierto} isMobile={isMobile} t={t} />
                    <Grupo titulo="Hoy" items={data.hoy} onAbrir={setAbierto} isMobile={isMobile} t={t} />
                    <Grupo titulo="Mañana" items={data.manana} onAbrir={setAbierto} isMobile={isMobile} t={t} />
                </>
            )}

            <ClienteFicha partnerId={abierto?.tipo === 'cliente' ? abierto.odoo_partner_id : null}
                resumen={abierto ? { partner_name: abierto.name } : null} onClose={cerrar} onCambio={marcar} />
            <LeadFicha leadId={abierto?.tipo === 'lead' ? abierto.lead_id : null}
                resumen={abierto?.tipo === 'lead' ? { name: abierto.name, phone: abierto.phone, city: abierto.city, source_status: abierto.source_status } : null}
                onClose={cerrar} onCambio={marcar} />
        </div>
    );
}
