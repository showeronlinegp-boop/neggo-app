import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useTheme } from '../theme/ThemeContext';
import { fmtPct } from '../theme/tokens';
import Card from '../components/common/Card';
import Stat from '../components/common/Stat';
import Badge from '../components/common/Badge';
import Button from '../components/common/Button';
import ProductThumb from '../components/common/ProductThumb';
import * as Icon from '../components/common/icons';
import api from '../api/client';

function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h / 24)}d`;
}

export default function Dashboard() {
    const { tokens: t } = useTheme();
    const { user } = useAuth();
    const { showToast } = useToast();
    const navigate = useNavigate();

    const [stats, setStats] = useState({
        alertsPending: null,
        activeOrders: null,
        unmappedProducts: null,
        lastRun: null,
    });
    const [recentAlerts, setRecentAlerts] = useState([]);
    const [recentRuns, setRecentRuns] = useState([]);
    const [recentActivity, setRecentActivity] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchAll() {
            setLoading(true);
            try {
                const [alertsSummary, alertsList, runsRes, ordersRes, mappingsRes, activityRes] = await Promise.all([
                    api.get('/alerts/summary'),
                    api.get('/alerts', { status: 'pending', limit: 4 }),
                    api.get('/scraping/runs', { limit: 5 }),
                    api.get('/preventas/client-orders', { status: 'pendiente', limit: 1 }),
                    api.get('/mappings', { unmapped: true, limit: 1 }),
                    api.get('/activity-log', { limit: 5 }),
                ]);

                setStats({
                    alertsPending: alertsSummary.success ? alertsSummary.data?.pending ?? 0 : '—',
                    activeOrders:  ordersRes.success  ? (ordersRes.pagination?.total ?? ordersRes.data?.length ?? 0) : '—',
                    unmappedProducts: mappingsRes.success ? (mappingsRes.total ?? mappingsRes.data?.length ?? 0) : '—',
                    lastRun: runsRes.success && runsRes.data?.[0] ? runsRes.data[0] : null,
                });
                if (alertsList.success) setRecentAlerts(alertsList.data || []);
                if (runsRes.success) setRecentRuns(runsRes.data || []);
                if (activityRes.success) setRecentActivity(activityRes.data || []);
            } catch {
                showToast('Error al cargar el dashboard', 'error');
            }
            setLoading(false);
        }
        fetchAll();
    }, []);

    const runStatus = stats.lastRun
        ? timeAgo(stats.lastRun.created_at)
        : '—';

    const runHint = stats.lastRun
        ? `${stats.lastRun.supplier_name || 'Desconocido'} · ${stats.lastRun.status === 'completed' ? 'OK' : stats.lastRun.status}`
        : 'Sin datos';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* KPIs */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: t.space[5],
            }}>
                <Card>
                    <Stat
                        label="Alertas pendientes"
                        value={loading ? '…' : String(stats.alertsPending)}
                        tone="accent"
                        hint="cambios de precio por revisar"
                        icon={<Icon.Bell size={14} color={t.color.textMuted} />}
                    />
                </Card>
                <Card>
                    <Stat
                        label="Pedidos activos"
                        value={loading ? '…' : String(stats.activeOrders)}
                        hint="pedidos pendientes"
                        icon={<Icon.ShoppingCart size={14} color={t.color.textMuted} />}
                    />
                </Card>
                <Card>
                    <Stat
                        label="Sin vincular a Odoo"
                        value={loading ? '…' : String(stats.unmappedProducts)}
                        hint="requieren vinculación"
                        icon={<Icon.Link size={14} color={t.color.textMuted} />}
                    />
                </Card>
                <Card>
                    <Stat
                        label="Último scraping"
                        value={loading ? '…' : runStatus}
                        hint={runHint}
                        icon={<Icon.Activity size={14} color={t.color.textMuted} />}
                    />
                </Card>
            </div>

            {/* Dos columnas */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
                gap: t.space[5],
            }} className="dash-two-col">

                {/* Alertas recientes */}
                <Card padding={false}>
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: `18px ${t.layout.cardPadX}px`,
                        borderBottom: `1px solid ${t.color.border}`,
                    }}>
                        <div>
                            <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, letterSpacing: '-0.01em', color: t.color.text, fontFamily: t.font.family }}>
                                Alertas que requieren atención
                            </div>
                            <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 2, fontFamily: t.font.family }}>
                                Revisá cambios de precio antes de actualizar Odoo
                            </div>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => navigate('/alertas')} rightIcon={<Icon.ArrowRight size={13} />}>
                            Ver todas
                        </Button>
                    </div>

                    {loading ? (
                        <AlertSkeleton tokens={t} />
                    ) : recentAlerts.length === 0 ? (
                        <EmptyAlerts tokens={t} />
                    ) : (
                        recentAlerts.map((a, i) => (
                            <AlertRow key={a.id} alert={a} last={i === recentAlerts.length - 1} tokens={t} />
                        ))
                    )}
                </Card>

                {/* Columna derecha */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

                    {/* Scraping reciente */}
                    <Card padding={false}>
                        <div style={{ padding: `18px ${t.layout.cardPadX}px 12px`, borderBottom: `1px solid ${t.color.border}` }}>
                            <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, letterSpacing: '-0.01em', fontFamily: t.font.family }}>
                                Scraping reciente
                            </div>
                            <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 2, fontFamily: t.font.family }}>
                                Últimas ejecuciones
                            </div>
                        </div>
                        <div style={{ padding: `0 ${t.layout.cardPadX}px 16px` }}>
                            {loading ? (
                                <RunSkeleton tokens={t} />
                            ) : recentRuns.length === 0 ? (
                                <div style={{ padding: '20px 0', fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>Sin datos de scraping.</div>
                            ) : (
                                recentRuns.map((run, i) => (
                                    <RunRow key={run.id} run={run} first={i === 0} tokens={t} />
                                ))
                            )}
                        </div>
                    </Card>

                    {/* Actividad reciente */}
                    <Card padding={false}>
                        <div style={{ padding: `18px ${t.layout.cardPadX}px 12px`, borderBottom: `1px solid ${t.color.border}` }}>
                            <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, letterSpacing: '-0.01em', fontFamily: t.font.family }}>
                                Actividad reciente
                            </div>
                        </div>
                        <div style={{ padding: `0 ${t.layout.cardPadX}px 16px` }}>
                            {loading ? (
                                <RunSkeleton tokens={t} />
                            ) : recentActivity.length === 0 ? (
                                <div style={{ padding: '20px 0', fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>Sin actividad reciente.</div>
                            ) : (
                                recentActivity.map((act, i) => (
                                    <ActivityRow key={act.id ?? i} activity={act} first={i === 0} tokens={t} />
                                ))
                            )}
                        </div>
                    </Card>
                </div>
            </div>

            <style>{`
                @media (max-width: 980px) {
                    .dash-two-col { grid-template-columns: 1fr !important; }
                }
            `}</style>
        </div>
    );
}

// ─── Filas de alerta ────────────────────────────────────────────────────────────
function AlertRow({ alert, last, tokens: t }) {
    const pct = Number(alert.price_change_pct ?? alert.change_pct ?? 0);
    const isOoS = alert.alert_type === 'out_of_stock' || alert.type === 'out_of_stock';
    const up = pct > 0;
    const initial = (alert.supplier_product_name || '?')[0];

    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: t.space[5],
            padding: `14px ${t.layout.cardPadX}px`,
            borderBottom: last ? 'none' : `1px solid ${t.color.border}`,
        }}>
            <ProductThumb emoji={initial} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.color.text, fontFamily: t.font.family }}>
                    {alert.supplier_product_name || '—'}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', gap: 6, alignItems: 'center', marginTop: 2, fontFamily: t.font.family }}>
                    <span>{alert.supplier_name || '—'}</span>
                    {alert.internal_sku && (
                        <>
                            <span style={{ color: t.color.textFaint }}>·</span>
                            <span style={{ fontFamily: t.font.mono }}>{alert.internal_sku}</span>
                        </>
                    )}
                    <span style={{ color: t.color.textFaint }}>·</span>
                    <span>{timeAgo(alert.created_at)}</span>
                </div>
            </div>
            <div>
                {isOoS ? (
                    <Badge tone="danger" dot>sin stock</Badge>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {up
                            ? <Icon.TrendUp size={13} color={t.color.danger} />
                            : <Icon.TrendDown size={13} color={t.color.success} />
                        }
                        <span style={{
                            fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold,
                            color: up ? t.color.danger : t.color.success,
                            ...t.numericStyle,
                        }}>
                            {fmtPct(pct)}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Fila de run de scraping ────────────────────────────────────────────────────
function RunRow({ run, first, tokens: t }) {
    const dotColor = run.status === 'completed' ? t.color.success
                   : run.status === 'failed'    ? t.color.danger
                   : t.color.warn;

    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: t.space[3],
            padding: '8px 0',
            borderTop: first ? 'none' : `1px solid ${t.color.border}`,
        }}>
            <span style={{ width: 6, height: 6, borderRadius: t.radius.full, background: dotColor, flexShrink: 0 }} />
            <span style={{ fontSize: t.font.size.sm, flex: 1, fontWeight: t.font.weight.medium, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: t.font.family }}>
                {run.supplier_name || 'Desconocido'}
            </span>
            {run.products_scraped != null && (
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>
                    {Number(run.products_scraped).toLocaleString('es-AR')}
                </span>
            )}
            <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint, minWidth: 54, textAlign: 'right', fontFamily: t.font.family }}>
                {timeAgo(run.created_at)}
            </span>
        </div>
    );
}

// ─── Fila de actividad ──────────────────────────────────────────────────────────
function ActivityRow({ activity, first, tokens: t }) {
    const name = activity.user_display_name || activity.username || 'Sistema';
    const initial = name[0]?.toUpperCase() ?? '?';

    return (
        <div style={{
            display: 'flex', alignItems: 'flex-start', gap: t.space[3],
            padding: '10px 0',
            borderTop: first ? 'none' : `1px solid ${t.color.border}`,
        }}>
            <div style={{
                width: 22, height: 22, borderRadius: t.radius.full,
                background: t.color.surface2, color: t.color.textMuted,
                fontSize: 10, fontWeight: t.font.weight.semibold, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginTop: 1, fontFamily: t.font.family,
            }}>
                {initial}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: t.font.size.sm, lineHeight: 1.4, fontFamily: t.font.family, color: t.color.text }}>
                    <span style={{ fontWeight: t.font.weight.medium }}>{name}</span>
                    {' '}
                    <span style={{ color: t.color.textMuted }}>{activity.action || activity.module}</span>
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2, fontFamily: t.font.family }}>
                    {activity.details || activity.module} · {timeAgo(activity.created_at)}
                </div>
            </div>
        </div>
    );
}

// ─── Skeletons ──────────────────────────────────────────────────────────────────
function AlertSkeleton({ tokens: t }) {
    return Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: t.space[5],
            padding: `14px ${t.layout.cardPadX}px`,
            borderBottom: i < 2 ? `1px solid ${t.color.border}` : 'none',
        }}>
            <div style={{ width: 40, height: 40, borderRadius: t.radius.sm, background: t.color.surface2 }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ height: 12, background: t.color.surface2, borderRadius: t.radius.sm, width: '60%' }} />
                <div style={{ height: 10, background: t.color.surface2, borderRadius: t.radius.sm, width: '40%' }} />
            </div>
        </div>
    ));
}

function RunSkeleton({ tokens: t }) {
    return Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: t.space[3], padding: '10px 0', borderTop: i > 0 ? `1px solid ${t.color.border}` : 'none', alignItems: 'center' }}>
            <div style={{ width: 6, height: 6, borderRadius: t.radius.full, background: t.color.surface2 }} />
            <div style={{ height: 11, background: t.color.surface2, borderRadius: t.radius.sm, flex: 1 }} />
        </div>
    ));
}

function EmptyAlerts({ tokens: t }) {
    return (
        <div style={{ padding: '40px 24px', textAlign: 'center' }}>
            <div style={{
                width: 48, height: 48, borderRadius: t.radius.full,
                background: t.color.surface2, color: t.color.textMuted,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 14px',
            }}>
                <Icon.Bell size={20} />
            </div>
            <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text, marginBottom: 4, fontFamily: t.font.family }}>Todo al día</div>
            <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>No hay alertas pendientes.</div>
        </div>
    );
}
