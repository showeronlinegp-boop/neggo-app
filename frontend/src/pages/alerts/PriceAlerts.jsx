import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtPct } from '../../theme/tokens';
import Tabs from '../../components/common/Tabs';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Modal from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

const TABS = [
    { value: 'pending',   label: 'Pendientes' },
    { value: 'approved',  label: 'Aprobadas' },
    { value: 'dismissed', label: 'Descartadas' },
];

export default function PriceAlerts() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [activeTab, setActiveTab] = useState('pending');
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [summary, setSummary] = useState({});
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [confirmApprove, setConfirmApprove] = useState(null);
    const [dismissModal, setDismissModal] = useState(null);
    const [dismissNote, setDismissNote] = useState('');
    const [actionLoading, setActionLoading] = useState(false);

    useEffect(() => { fetchSummary(); }, []);
    useEffect(() => { setPage(1); }, [activeTab]);
    useEffect(() => { fetchData(); }, [activeTab, page]);

    async function fetchSummary() {
        const res = await api.get('/alerts/summary');
        if (res.success) setSummary(res.data || {});
    }

    async function fetchData() {
        setLoading(true);
        const res = await api.get('/alerts', { status: activeTab, limit: 20, offset: (page - 1) * 20 });
        if (res.success) { setData(res.data || []); setTotal(res.pagination?.total || res.data?.length || 0); }
        else showToast(res.error || 'Error al cargar alertas', 'error');
        setLoading(false);
    }

    async function handleApprove() {
        setActionLoading(true);
        const res = await api.put(`/alerts/${confirmApprove.id}/approve`);
        setActionLoading(false); setConfirmApprove(null);
        if (res.success) { showToast('Alerta aprobada — Odoo actualizado', 'success'); fetchData(); fetchSummary(); }
        else showToast(res.error || 'Error al aprobar', 'error');
    }

    async function handleDismiss() {
        setActionLoading(true);
        const res = await api.put(`/alerts/${dismissModal.id}/dismiss`, { note: dismissNote });
        setActionLoading(false); setDismissModal(null); setDismissNote('');
        if (res.success) { showToast('Alerta descartada', 'success'); fetchData(); fetchSummary(); }
        else showToast(res.error || 'Error al descartar', 'error');
    }

    const tabs = TABS.map(tab => ({
        ...tab,
        count: summary[tab.value] ?? undefined,
    }));

    const totalPages = Math.ceil(total / 20) || 1;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            <Tabs tabs={tabs} value={activeTab} onChange={setActiveTab} />

            {/* Grid de cards */}
            {loading ? (
                <SkeletonGrid tokens={t} />
            ) : data.length === 0 ? (
                <EmptyState tokens={t} tab={activeTab} />
            ) : (
                <>
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
                        gap: t.space[5],
                    }}>
                        {data.map(alert => (
                            <AlertCard
                                key={alert.id}
                                alert={alert}
                                tab={activeTab}
                                tokens={t}
                                onApprove={() => setConfirmApprove(alert)}
                                onDismiss={() => { setDismissModal(alert); setDismissNote(''); }}
                            />
                        ))}
                    </div>

                    {/* Paginación */}
                    {totalPages > 1 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                            <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                                Página {page} de {totalPages} · {total} alertas
                            </span>
                            <div style={{ display: 'flex', gap: t.space[2] }}>
                                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                                    ← Anterior
                                </Button>
                                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                                    Siguiente →
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Confirm aprobar */}
            <ConfirmDialog
                isOpen={!!confirmApprove}
                onClose={() => setConfirmApprove(null)}
                onConfirm={handleApprove}
                title="Aprobar cambio de precio"
                message={`¿Aprobás el cambio de precio de "${confirmApprove?.supplier_product_name}"? Esto actualiza los precios en Odoo.`}
                confirmLabel={actionLoading ? 'Aprobando…' : 'Aprobar y actualizar Odoo'}
            />

            {/* Modal descartar */}
            <Modal
                isOpen={!!dismissModal}
                onClose={() => setDismissModal(null)}
                title="Descartar alerta"
                subtitle={dismissModal?.supplier_product_name}
                size="sm"
                footer={
                    <>
                        <Button variant="ghost" onClick={() => setDismissModal(null)}>Cancelar</Button>
                        <Button variant="danger" onClick={handleDismiss} disabled={actionLoading}>
                            {actionLoading ? 'Descartando…' : 'Descartar'}
                        </Button>
                    </>
                }
            >
                <div>
                    <label style={{
                        display: 'block', marginBottom: t.space[2],
                        fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
                        color: t.color.textMuted, fontFamily: t.font.family,
                    }}>
                        Nota (opcional)
                    </label>
                    <textarea
                        value={dismissNote}
                        onChange={e => setDismissNote(e.target.value)}
                        placeholder="Motivo del descarte…"
                        rows={3}
                        style={{
                            width: '100%',
                            padding: '8px 12px',
                            border: `1px solid ${t.color.borderStrong}`,
                            borderRadius: t.radius.sm,
                            fontSize: t.font.size.base,
                            fontFamily: t.font.family,
                            color: t.color.text,
                            background: t.color.surface,
                            resize: 'vertical',
                            boxSizing: 'border-box',
                            outline: 'none',
                        }}
                    />
                </div>
            </Modal>
        </div>
    );
}

// ─── Card de alerta ─────────────────────────────────────────────────────────────
function AlertCard({ alert, tab, tokens: t, onApprove, onDismiss }) {
    const isOoS = alert.alert_type === 'out_of_stock' || alert.type === 'out_of_stock';
    const pct   = Number(alert.pct_change ?? alert.price_change_pct ?? 0);
    const up    = pct > 0;
    const tone  = isOoS ? 'danger' : (up ? 'danger' : 'success');
    const linked = alert.linked_products || alert.products || [];

    return (
        <Card padding={false} style={{ display: 'flex', flexDirection: 'column' }}>

            {/* Header */}
            <div style={{
                padding: `14px 16px`,
                borderBottom: `1px solid ${t.color.border}`,
                display: 'flex', alignItems: 'center', gap: 12,
            }}>
                <ProductThumb
                    imageUrl={alert.image_url}
                    emoji={alert.supplier_product_name?.[0]}
                    size={42}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                        fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold,
                        lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        color: t.color.text, fontFamily: t.font.family,
                    }}>
                        {alert.supplier_product_name || '—'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                            {alert.supplier_name}
                        </span>
                        {alert.internal_sku && (
                            <>
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>·</span>
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.mono }}>
                                    {alert.internal_sku}
                                </span>
                            </>
                        )}
                    </div>
                </div>
                {/* Delta */}
                {isOoS ? (
                    <Badge tone="danger" dot>sin stock</Badge>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: up ? t.color.danger : t.color.success, fontWeight: t.font.weight.semibold, flexShrink: 0 }}>
                        {up
                            ? <Icon.TrendUp size={14} color={t.color.danger} />
                            : <Icon.TrendDown size={14} color={t.color.success} />
                        }
                        <span style={{ fontSize: 14, ...t.numericStyle }}>{fmtPct(pct)}</span>
                    </div>
                )}
            </div>

            {/* Comparativa de precios */}
            {!isOoS && alert.old_price != null && alert.new_price != null && (
                <div style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginBottom: 2, fontFamily: t.font.family }}>Antes</div>
                        <div style={{ fontSize: 17, fontWeight: t.font.weight.medium, color: t.color.textMuted, textDecoration: 'line-through', ...t.numericStyle }}>
                            {fmtAR(alert.old_price)}
                        </div>
                    </div>
                    <Icon.ArrowRight size={16} color={t.color.textFaint} />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginBottom: 2, fontFamily: t.font.family }}>Ahora</div>
                        <div style={{
                            fontSize: 17, fontWeight: t.font.weight.semibold,
                            color: up ? t.color.danger : t.color.success,
                            ...t.numericStyle,
                        }}>
                            {fmtAR(alert.new_price)}
                        </div>
                    </div>
                </div>
            )}

            {/* Vinculados a Odoo */}
            {linked.length > 0 && (
                <div style={{
                    padding: '12px 16px',
                    background: t.color.surface2,
                    borderTop: `1px solid ${t.color.border}`,
                }}>
                    <div style={{
                        fontSize: t.font.size.xs, color: t.color.textMuted,
                        marginBottom: 8, fontWeight: t.font.weight.semibold,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                        fontFamily: t.font.family,
                    }}>
                        Vinculados a Odoo · {linked.length}
                    </div>
                    {linked.map((l, i) => (
                        <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 0',
                            borderTop: i > 0 ? `1px solid ${t.color.border}` : 'none',
                        }}>
                            <Badge
                                tone={l.company === 'neggo' ? 'primary' : 'accent'}
                                style={{ minWidth: 70, justifyContent: 'center' }}
                            >
                                {l.company}
                            </Badge>
                            <span style={{ flex: 1, fontSize: t.font.size.sm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.color.text, fontFamily: t.font.family }}>
                                {l.name || l.odoo_product_name}
                            </span>
                            {(l.currentCost ?? l.current_cost) != null && (
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>
                                    costo {fmtAR(l.currentCost ?? l.current_cost)}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Acciones / estado */}
            <div style={{
                padding: '12px 16px',
                display: 'flex', gap: 8, alignItems: 'center',
                borderTop: `1px solid ${t.color.border}`,
                marginTop: 'auto',
            }}>
                {tab !== 'pending' ? (
                    <div style={{
                        flex: 1, display: 'flex', alignItems: 'center', gap: 8,
                        fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family,
                    }}>
                        {tab === 'approved' ? (
                            <><Icon.Check size={14} color={t.color.success} /> Aprobada</>
                        ) : (
                            <><Icon.X size={14} color={t.color.textFaint} /> Descartada</>
                        )}
                        {alert.created_at && (
                            <span style={{ color: t.color.textFaint }}>
                                · {new Date(alert.created_at).toLocaleDateString('es-AR')}
                            </span>
                        )}
                    </div>
                ) : (
                    <>
                        <Button
                            size="sm" variant="ghost"
                            leftIcon={<Icon.X size={13} />}
                            onClick={onDismiss}
                            style={{ flex: 1 }}
                        >
                            Descartar
                        </Button>
                        <Button
                            size="sm" variant="primary"
                            leftIcon={<Icon.Check size={13} />}
                            onClick={onApprove}
                            style={{ flex: 2 }}
                        >
                            Aprobar y actualizar Odoo
                        </Button>
                    </>
                )}
            </div>
        </Card>
    );
}

// ─── Empty state ─────────────────────────────────────────────────────────────────
function EmptyState({ tokens: t, tab }) {
    const msgs = {
        pending:   'No hay alertas pendientes — todo al día.',
        approved:  'No hay alertas aprobadas en este período.',
        dismissed: 'No hay alertas descartadas.',
    };
    return (
        <Card style={{ padding: '60px 24px', textAlign: 'center' }}>
            <div style={{
                width: 48, height: 48, borderRadius: t.radius.full,
                background: t.color.surface2, color: t.color.textMuted,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 14px',
            }}>
                <Icon.Bell size={20} />
            </div>
            <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text, marginBottom: 4, fontFamily: t.font.family }}>
                Todo al día
            </div>
            <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                {msgs[tab]}
            </div>
        </Card>
    );
}

// ─── Skeleton loading ────────────────────────────────────────────────────────────
function SkeletonGrid({ tokens: t }) {
    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
            gap: t.space[5],
        }}>
            {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} padding={false} style={{ height: 200 }}>
                    <div style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'center', borderBottom: `1px solid ${t.color.border}` }}>
                        <div style={{ width: 42, height: 42, borderRadius: t.radius.sm, background: t.color.surface2 }} />
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{ height: 12, background: t.color.surface2, borderRadius: t.radius.sm, width: '70%' }} />
                            <div style={{ height: 10, background: t.color.surface2, borderRadius: t.radius.sm, width: '45%' }} />
                        </div>
                    </div>
                    <div style={{ padding: '14px 16px', display: 'flex', gap: 16 }}>
                        <div style={{ flex: 1, height: 32, background: t.color.surface2, borderRadius: t.radius.sm }} />
                        <div style={{ width: 24, height: 24, background: t.color.surface2, borderRadius: t.radius.sm, alignSelf: 'center' }} />
                        <div style={{ flex: 1, height: 32, background: t.color.surface2, borderRadius: t.radius.sm }} />
                    </div>
                </Card>
            ))}
        </div>
    );
}
