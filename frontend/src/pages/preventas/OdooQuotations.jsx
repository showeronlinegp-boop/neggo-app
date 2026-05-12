import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Stat from '../../components/common/Stat';
import * as Icon from '../../components/common/icons';

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

function quotationStateTone(state) {
    if (state === 'draft') return 'warn';
    if (state === 'sent')  return 'primary';
    return 'muted';
}

export default function OdooQuotations() {
    const { tokens: t } = useTheme();
    const [quotations, setQuotations] = useState([]);
    const [commitments, setCommitments] = useState({});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState(null);
    const [search, setSearch] = useState('');

    const load = async () => {
        setLoading(true); setError(null);
        try {
            const [quotRes, commRes] = await Promise.all([
                api.get('/preventas/odoo-quotations'),
                api.get('/preventas/ingreso-commitments'),
            ]);
            if (quotRes.success) setQuotations(quotRes.data || []);
            else setError(quotRes.error || 'Error al cargar cotizaciones');
            if (commRes.success) setCommitments(commRes.data || {});
        } catch (err) { setError(err.message); }
        finally { setLoading(false); }
    };

    useEffect(() => { load(); }, []);

    const filtered = quotations.filter(q => {
        if (!search) return true;
        const s = search.toLowerCase();
        return q.name?.toLowerCase().includes(s) || q.client?.toLowerCase().includes(s) || q.lines?.some(l => l.product_name?.toLowerCase().includes(s));
    });

    const totalItems  = filtered.reduce((sum, q) => sum + (q.lines?.length || 0), 0);
    const totalAmount = filtered.reduce((sum, q) => sum + (q.total || 0), 0);

    const thStyle = {
        padding: '8px 12px', textAlign: 'left',
        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
        color: t.color.textMuted, background: t.color.surface2,
        borderBottom: `1px solid ${t.color.border}`,
        textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family,
    };
    const tdStyle = { padding: '8px 12px', fontSize: t.font.size.sm, borderBottom: `1px solid ${t.color.border}`, fontFamily: t.font.family, color: t.color.text };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Cabecera */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} disabled={loading} onClick={load}>
                    {loading ? 'Cargando…' : 'Actualizar'}
                </Button>
            </div>

            {error && (
                <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '12px 16px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {error}
                </div>
            )}

            {/* Stats */}
            {!loading && quotations.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: t.space[3] }}>
                    <Card><Stat label="Cotizaciones" value={filtered.length} icon={<Icon.FileText size={14} color={t.color.textMuted} />} /></Card>
                    <Card><Stat label="Líneas totales" value={totalItems} icon={<Icon.Package size={14} color={t.color.textMuted} />} /></Card>
                    <Card><Stat label="Monto total" value={fmtAR(totalAmount)} icon={<Icon.Activity size={14} color={t.color.textMuted} />} /></Card>
                </div>
            )}

            {/* Búsqueda */}
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por cliente, número o producto…" leftIcon={<Icon.Search size={14} />} style={{ maxWidth: 440 }} />

            {/* Contenido */}
            {loading ? (
                <div style={{ textAlign: 'center', padding: 60, color: t.color.textMuted, fontFamily: t.font.family }}>Conectando con Odoo Preventas…</div>
            ) : filtered.length === 0 ? (
                <Card style={{ padding: '60px 24px', textAlign: 'center' }}>
                    <div style={{ fontSize: 48, marginBottom: 12 }}>📄</div>
                    <div style={{ fontWeight: t.font.weight.medium, color: t.color.text, marginBottom: 6, fontFamily: t.font.family }}>
                        {search ? 'Sin coincidencias' : 'No hay cotizaciones abiertas en Odoo Preventas'}
                    </div>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                        {search ? 'Probá con otro término' : 'Los pedidos en borrador o enviados aparecen acá'}
                    </div>
                </Card>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                    {filtered.map(q => (
                        <Card key={q.id} padding={false}>
                            {/* Cabecera */}
                            <div
                                onClick={() => setExpanded(expanded === q.id ? null : q.id)}
                                onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                style={{ padding: '14px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: t.space[5], flexWrap: 'wrap', userSelect: 'none', transition: 'background 100ms' }}
                            >
                                <Icon.ChevronRight size={14} color={t.color.textFaint} style={{ transform: expanded === q.id ? 'rotate(90deg)' : 'none', transition: 'transform 150ms', flexShrink: 0 }} />
                                <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.primary, minWidth: 100, fontFamily: t.font.family }}>{q.name}</span>
                                <Badge tone={quotationStateTone(q.state)}>{q.state === 'draft' ? 'Borrador' : 'Enviada'}</Badge>
                                <span style={{ flex: 1, fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>{q.client || <span style={{ color: t.color.textFaint, fontStyle: 'italic' }}>Sin cliente</span>}</span>
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap', fontFamily: t.font.family }}>{fmtDate(q.date)}</span>
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>{q.lines?.length || 0} línea{q.lines?.length !== 1 ? 's' : ''}</span>
                                {(() => {
                                    const withCommit = (q.lines || []).filter(l => commitments[l.product_id] > 0);
                                    if (!withCommit.length) return null;
                                    const complete = withCommit.every(l => commitments[l.product_id] >= l.quantity);
                                    return <Badge tone={complete ? 'success' : 'warn'}>{complete ? 'Ingreso completo' : `${withCommit.length} pedido${withCommit.length !== 1 ? 's' : ''}`}</Badge>;
                                })()}
                                <span style={{ fontWeight: t.font.weight.semibold, fontSize: 15, color: t.color.primary, minWidth: 110, textAlign: 'right', fontFamily: t.font.family, ...t.numericStyle }}>{fmtAR(q.total)}</span>
                            </div>

                            {/* Líneas expandidas */}
                            {expanded === q.id && (
                                <div style={{ borderTop: `1px solid ${t.color.border}` }}>
                                    {!q.lines?.length ? (
                                        <div style={{ padding: '14px 18px', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>Sin líneas de productos.</div>
                                    ) : (
                                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                            <thead>
                                                <tr>
                                                    <th style={thStyle}>Producto</th>
                                                    <th style={{ ...thStyle, textAlign: 'right' }}>Cantidad</th>
                                                    <th style={{ ...thStyle, textAlign: 'center' }}>Estado ingreso</th>
                                                    <th style={{ ...thStyle, textAlign: 'right' }}>Precio unit.</th>
                                                    <th style={{ ...thStyle, textAlign: 'right' }}>Subtotal</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {q.lines.map(line => {
                                                    const committed  = commitments[line.product_id] || 0;
                                                    const pending    = Math.max(0, line.quantity - committed);
                                                    const isComplete = committed >= line.quantity;
                                                    const hasCommit  = committed > 0;
                                                    const rowBg = isComplete ? t.color.successSoft : hasCommit ? t.color.warnSoft : 'transparent';
                                                    return (
                                                        <tr key={line.id} style={{ background: rowBg }}>
                                                            <td style={{ ...tdStyle, fontWeight: t.font.weight.medium }}>{line.product_name}</td>
                                                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: t.font.weight.semibold, ...t.numericStyle }}>{Number(line.quantity).toLocaleString('es-AR')}</td>
                                                            <td style={{ ...tdStyle, textAlign: 'center' }}>
                                                                {isComplete ? <Badge tone="success" dot>Pedido {committed}</Badge>
                                                                : hasCommit ? (
                                                                    <div style={{ display: 'inline-flex', gap: 4 }}>
                                                                        <Badge tone="success" dot>Pedido {committed}</Badge>
                                                                        <Badge tone="warn">Disponible {pending}</Badge>
                                                                    </div>
                                                                ) : <span style={{ color: t.color.textFaint }}>—</span>}
                                                            </td>
                                                            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: t.font.mono, ...t.numericStyle }}>{fmtAR(line.unit_price)}</td>
                                                            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: t.font.mono, fontWeight: t.font.weight.semibold, color: t.color.primary, ...t.numericStyle }}>{fmtAR(line.subtotal)}</td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            )}
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
