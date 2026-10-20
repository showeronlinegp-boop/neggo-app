import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import BackupCard from './BackupCard';

function formatFecha(ts) {
    if (!ts) return 'Nunca';
    return new Date(ts).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        + ' ' + new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function tiempoDesde(ts) {
    if (!ts) return null;
    const mins = Math.floor((Date.now() - new Date(ts)) / 60000);
    if (mins < 1)  return 'hace menos de 1 min';
    if (mins < 60) return `hace ${mins} min`;
    const hs = Math.floor(mins / 60);
    if (hs < 24)   return `hace ${hs} hs`;
    return `hace ${Math.floor(hs / 24)} días`;
}

export default function AdminPanel() {
    const { tokens: t } = useTheme();
    const [syncingOdoo, setSyncingOdoo] = useState(false);
    const [syncResult, setSyncResult] = useState(null);
    const [syncStatus, setSyncStatus] = useState(null);

    useEffect(() => { cargarStatus(); }, []);

    async function cargarStatus() {
        try {
            const res = await api.get('/products/odoo/sync/status');
            if (res.success) setSyncStatus(res.data);
        } catch (_) {}
    }

    async function handleSyncOdoo() {
        setSyncingOdoo(true); setSyncResult(null);
        try {
            const res = await api.post('/products/odoo/sync');
            if (res.success) { setSyncResult({ ok: true, msg: res.data?.message || 'Sync completado' }); await cargarStatus(); }
            else setSyncResult({ ok: false, msg: res.error || 'Error al sincronizar con Odoo' });
        } catch (err) { setSyncResult({ ok: false, msg: err.message || 'Error de conexión' }); }
        finally { setSyncingOdoo(false); }
    }

    return (
        <div style={{ maxWidth: 800, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            <Card>
                <div style={{ marginBottom: t.space[5] }}>
                    <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: 4, fontFamily: t.font.family }}>
                        Integración Odoo
                    </div>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, lineHeight: 1.6, fontFamily: t.font.family }}>
                        Cada sync trae <strong>todos</strong> los productos de Odoo (activos e inactivos) para ambas empresas.
                        El sync automático corre <strong>cada 1 hora</strong>. También podés forzarlo manualmente.
                    </div>
                </div>

                {/* Estado por empresa */}
                {syncStatus && (
                    <div style={{ display: 'flex', gap: t.space[3], marginBottom: t.space[5], flexWrap: 'wrap' }}>
                        {['neggo', 'preventas'].map(key => {
                            const info = syncStatus[key];
                            return (
                                <div key={key} style={{
                                    flex: 1, minWidth: 200,
                                    border: `1px solid ${t.color.border}`,
                                    borderRadius: t.radius.sm,
                                    padding: `${t.space[3]}px ${t.space[5]}px`,
                                    background: t.color.surface2,
                                }}>
                                    <div style={{ fontSize: 11, color: t.color.textFaint, fontWeight: t.font.weight.semibold, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: t.space[1], fontFamily: t.font.family }}>
                                        {key}
                                    </div>
                                    <div style={{ fontSize: t.font.size.sm, color: t.color.text, fontWeight: t.font.weight.medium, fontFamily: t.font.family }}>
                                        {info?.last_sync ? formatFecha(info.last_sync) : 'Sin sincronizar'}
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: t.space[1] }}>
                                        {info?.last_sync && (
                                            <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family }}>
                                                {tiempoDesde(info.last_sync)}
                                            </span>
                                        )}
                                        {info?.records_synced > 0 && (
                                            <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle, fontFamily: t.font.family }}>
                                                {info.records_synced.toLocaleString('es-AR')} productos
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                    <Button
                        variant="primary"
                        leftIcon={<Icon.Refresh size={15} />}
                        disabled={syncingOdoo}
                        onClick={handleSyncOdoo}
                    >
                        {syncingOdoo ? 'Sincronizando…' : 'Sincronizar con Odoo'}
                    </Button>

                    {syncResult && (
                        <Badge tone={syncResult.ok ? 'success' : 'danger'} dot>
                            {syncResult.msg}
                        </Badge>
                    )}
                </div>
            </Card>

            <BackupCard />
        </div>
    );
}
