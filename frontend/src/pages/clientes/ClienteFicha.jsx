import { useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Drawer from '../../components/common/Drawer';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import BarrasMensuales from './BarrasMensuales';
import Seguimiento from './Seguimiento';
import {
    HEALTH_META, COMPANY_LABEL, QUOTATION_STATE,
    fmtHace, fmtFecha, fmtIntervalo, linkWhatsApp,
} from './clientesUi';

function Seccion({ titulo, children, t }) {
    return (
        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
            <h3 style={{
                margin: 0, fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted,
                textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
                {titulo}
            </h3>
            {children}
        </section>
    );
}

function Dato({ label, value, hint, t }) {
    return (
        <div style={{ background: t.color.surface2, borderRadius: t.radius.md, padding: '10px 12px', minWidth: 0 }}>
            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{label}</div>
            <div style={{ fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text, marginTop: 2, ...t.numericStyle }}>
                {value}
            </div>
            {hint && <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2 }}>{hint}</div>}
        </div>
    );
}

function Fila({ izquierda, derecha, abajo, t }) {
    return (
        <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3],
            padding: '8px 0', borderTop: `1px solid ${t.color.border}`,
        }}>
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {izquierda}
                </div>
                {abajo && <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2, ...t.numericStyle }}>{abajo}</div>}
            </div>
            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, textAlign: 'right', flexShrink: 0, ...t.numericStyle }}>
                {derecha}
            </div>
        </div>
    );
}

function Vacio({ children, t }) {
    return <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>{children}</div>;
}

export default function ClienteFicha({ partnerId, resumen, onClose, onCambio }) {
    const { tokens: t } = useTheme();
    const [cliente, setCliente] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!partnerId) return undefined;
        let cancelado = false;
        setLoading(true);
        setError(null);
        setCliente(null);
        api.get(`/clientes/${partnerId}`).then((res) => {
            if (cancelado) return;
            setLoading(false);
            if (!res.success) { setError(res.error || 'No se pudo cargar el cliente'); return; }
            setCliente(res.data);
        });
        return () => { cancelado = true; };
    }, [partnerId]);

    const meta = cliente ? HEALTH_META[cliente.health] || HEALTH_META.sin_compras : null;
    const wa = cliente ? linkWhatsApp(cliente.phone) : null;
    const subtitulo = cliente
        ? [cliente.city, cliente.phone].filter(Boolean).join(' · ') || 'Sin ciudad ni teléfono en Odoo'
        : null;

    return (
        <Drawer
            isOpen={!!partnerId}
            onClose={onClose}
            title={cliente?.partner_name || resumen?.partner_name || 'Cliente'}
            subtitle={subtitulo}
            width={560}
            footer={wa ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', flex: 1 }}>
                    <a href={wa} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                        <Button variant="primary" leftIcon={<Icon.MessageCircle size={16} />}>Escribile por WhatsApp</Button>
                    </a>
                </div>
            ) : null}
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[10], fontFamily: t.font.family }}>
                {loading && <Vacio t={t}>Cargando la ficha…</Vacio>}
                {error && <div style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}

                {cliente && (
                    <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2], alignItems: 'center' }}>
                            <Badge tone={meta.tone} dot>{meta.label}</Badge>
                            <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{meta.hint}</span>
                            {cliente.rubro && <Badge tone="primary">{cliente.rubro}</Badge>}
                            {(cliente.tags || []).filter((tag) => tag !== 'Historico').map((tag) => (
                                <Badge key={tag} tone="muted">{tag}</Badge>
                            ))}
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: t.space[3] }}>
                            <Dato t={t} label="Facturación 12 meses" value={fmtAR(cliente.revenue_12m)}
                                hint={cliente.trend_pct != null ? `${cliente.trend_pct > 0 ? '+' : ''}${cliente.trend_pct}% últimos 90 días` : null} />
                            <Dato t={t} label="Ticket promedio" value={fmtAR(cliente.avg_ticket)} hint={`${fmtInt(cliente.purchase_count)} compras en total`} />
                            <Dato t={t} label="Ritmo de compra" value={fmtIntervalo(cliente.median_interval_days, cliente.interval_is_default)} />
                            <Dato t={t} label="Última compra" value={fmtHace(cliente.days_since_last_purchase)} hint={fmtFecha(cliente.last_purchase_date)} />
                            <Dato t={t} label="Cliente desde" value={fmtFecha(cliente.first_purchase_date)} />
                        </div>

                        <Seguimiento tipo="cliente" id={partnerId} onCambio={onCambio} />

                        <Seccion titulo="Compras por mes" t={t}>
                            {Number(cliente.revenue_12m) > 0
                                ? <BarrasMensuales data={cliente.monthly_revenue || []} />
                                : <Vacio t={t}>No compró en el último año.</Vacio>}
                        </Seccion>

                        <Seccion titulo="Motivo para hablarle" t={t}>
                            {(cliente.open_quotations || []).length === 0 ? (
                                <Vacio t={t}>No tiene cotizaciones abiertas en los últimos 60 días, ni en Neggo ni en Preventas.</Vacio>
                            ) : (
                                <div>
                                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginBottom: t.space[2] }}>
                                        Cotizaciones abiertas de los últimos 60 días: buena excusa para preguntarle si sigue en pie.
                                    </div>
                                    {cliente.open_quotations.map((q) => (
                                        <Fila key={`${q.company}-${q.odoo_id}`} t={t}
                                            izquierda={(
                                                <span style={{ display: 'inline-flex', gap: t.space[2], alignItems: 'center' }}>
                                                    <span style={{ fontFamily: t.font.mono }}>{q.name}</span>
                                                    <Badge tone={q.company === 'preventas' ? 'accent' : 'primary'}>{COMPANY_LABEL[q.company] || q.company}</Badge>
                                                    <Badge tone={q.state === 'sent' ? 'warn' : 'muted'}>{QUOTATION_STATE[q.state] || q.state}</Badge>
                                                </span>
                                            )}
                                            abajo={fmtFecha(q.date)}
                                            derecha={fmtAR(q.amount)}
                                        />
                                    ))}
                                </div>
                            )}
                        </Seccion>

                        <Seccion titulo="Lo que más compra (12 meses)" t={t}>
                            {(cliente.top_products || []).length === 0 ? (
                                <Vacio t={t}>Sin compras en el último año.</Vacio>
                            ) : (
                                <div>
                                    {cliente.top_products.map((p) => (
                                        <Fila key={p.product_id} t={t}
                                            izquierda={p.name}
                                            abajo={`${fmtInt(p.qty)} u. · última vez ${fmtFecha(p.last_date)}`}
                                            derecha={fmtAR(p.amount)}
                                        />
                                    ))}
                                </div>
                            )}
                        </Seccion>

                        <Seccion titulo="Últimos tickets" t={t}>
                            {cliente.recent_purchases_error && <Vacio t={t}>{cliente.recent_purchases_error}</Vacio>}
                            {!cliente.recent_purchases_error && (cliente.recent_purchases || []).length === 0 && (
                                <Vacio t={t}>Todavía no compró en el punto de venta.</Vacio>
                            )}
                            {(cliente.recent_purchases || []).length > 0 && (
                                <div>
                                    {cliente.recent_purchases.map((o) => (
                                        <Fila key={o.odoo_id} t={t}
                                            izquierda={<span style={{ fontFamily: t.font.mono }}>{o.name}</span>}
                                            abajo={`${fmtFecha(o.date)} · ${fmtInt(o.items)} línea${o.items === 1 ? '' : 's'}`}
                                            derecha={fmtAR(o.amount)}
                                        />
                                    ))}
                                </div>
                            )}
                        </Seccion>
                    </>
                )}
            </div>
        </Drawer>
    );
}
