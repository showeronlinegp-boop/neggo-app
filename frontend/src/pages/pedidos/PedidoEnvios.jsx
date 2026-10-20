import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Tabs from '../../components/common/Tabs';
import * as Icon from '../../components/common/icons';

const ESTADO = {
    pendiente:   { label: 'Para armar',     tone: 'muted' },
    armando:     { label: 'Armando',        tone: 'accent' },
    armado:      { label: 'Para controlar', tone: 'warn' },
    controlando: { label: 'Controlando',    tone: 'primary' },
    saldado:     { label: 'Saldado',        tone: 'success' },
};

const fmtFecha = (iso) => iso
    ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

export default function PedidoEnvios() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const navigate = useNavigate();
    const [tab, setTab] = useState('armar');
    const [company, setCompany] = useState('neggo');
    const [q, setQ] = useState('');
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState(null);
    const [aviso, setAviso] = useState(null);

    const cargar = useCallback(async () => {
        setLoading(true);
        setError(null);
        const res = await api.get('/pedido-envios', { tab, company, q });
        setLoading(false);
        if (!res.success) {
            setError(res.error || 'No se pudieron cargar los pedidos');
            return;
        }
        setItems(res.data || []);
    }, [tab, company, q]);

    useEffect(() => { cargar(); }, [cargar]);

    const sync = async () => {
        setSyncing(true);
        setError(null);
        const res = await api.post('/pedido-envios/sync', { company });
        setSyncing(false);
        if (!res.success) {
            setError(res.error || 'No pude hablar con Odoo');
            return;
        }
        setAviso(`Odoo: ${res.data.leidos} órdenes, ${res.data.creados} nuevas, ${res.data.actualizados} actualizadas.`);
        cargar();
    };

    const pad = isMobile ? 12 : t.layout.cardPadX;

    return (
        <div style={{ padding: isMobile ? 12 : `${t.layout.cardPadY}px ${t.layout.cardPadX}px`, maxWidth: 720, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: isMobile ? 22 : t.font.size['2xl'], fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                        Armado y control
                    </h1>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4, fontFamily: t.font.family }}>
                        Al empezar a armar se confirma el pedido en Odoo y se ata al envío 1. Las facturadas no aparecen. Al cerrar, Odoo queda con lo que salió y se arma un pedido con lo que faltó.
                    </div>
                </div>
                <Button variant="secondary" leftIcon={<Icon.Refresh size={16} />} disabled={syncing} onClick={sync}
                    style={isMobile ? { height: 44, flexShrink: 0 } : undefined}>
                    {syncing ? 'Odoo…' : 'Traer de Odoo'}
                </Button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                {['neggo', 'preventas'].map((c) => (
                    <button
                        key={c}
                        type="button"
                        onClick={() => setCompany(c)}
                        style={{
                            border: `1px solid ${company === c ? t.color.primary : t.color.borderStrong}`,
                            background: company === c ? t.color.primarySoft : t.color.surface,
                            color: company === c ? t.color.primary : t.color.textMuted,
                            borderRadius: t.radius.full, padding: '8px 14px',
                            fontFamily: t.font.family, fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
                            cursor: 'pointer', minHeight: 40,
                        }}
                    >
                        {c === 'neggo' ? 'Neggo' : 'Preventas'}
                    </button>
                ))}
            </div>

            <Tabs
                fullWidth={isMobile}
                tabs={[
                    { value: 'armar', label: 'Armar' },
                    { value: 'controlar', label: 'Controlar' },
                    { value: 'hechos', label: 'Saldados' },
                ]}
                value={tab}
                onChange={(v) => { setTab(v); setAviso(null); }}
            />

            <div style={{ margin: '12px 0' }}>
                <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Buscá por número o cliente…"
                    leftIcon={<Icon.Search size={14} />}
                />
            </div>

            {aviso && (
                <div style={{ marginBottom: 12, padding: '10px 12px', background: t.color.successSoft, color: t.color.success, borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {aviso}
                </div>
            )}
            {error && (
                <div style={{ marginBottom: 12, padding: '10px 12px', background: t.color.dangerSoft, color: t.color.danger, borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {error}
                </div>
            )}

            {loading ? (
                <div style={{ padding: 24, color: t.color.textMuted, fontFamily: t.font.family }}>Cargando pedidos…</div>
            ) : items.length === 0 ? (
                <Card style={{ textAlign: 'center', padding: 28 }}>
                    <div style={{ fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family }}>
                        {tab === 'armar' ? 'No hay pedidos para armar'
                            : tab === 'controlar' ? 'No hay nada para controlar'
                            : 'Todavía no saldaste ningún pedido'}
                    </div>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 6, fontFamily: t.font.family }}>
                        Tocá «Traer de Odoo» para bajar las cotizaciones enviadas (hasta 80, últimos 30 días). Las facturadas no entran.
                    </div>
                </Card>
            ) : (
                <Card padding={false} style={{ overflow: 'hidden' }}>
                    {items.map((it) => {
                        const est = ESTADO[it.estado] || ESTADO.pendiente;
                        const pedida = Number(it.qty_pedida) || 0;
                        const hecha = tab === 'controlar' || tab === 'hechos'
                            ? Number(it.qty_controlada) || 0
                            : Number(it.qty_armada) || 0;
                        return (
                            <button
                                key={it.id}
                                type="button"
                                onClick={() => navigate(`/pedidos/armado/${it.id}`)}
                                style={{
                                    display: 'flex', width: '100%', gap: 12, alignItems: 'center',
                                    padding: `${isMobile ? 14 : 12}px ${pad}px`,
                                    border: 'none', borderTop: `1px solid ${t.color.border}`,
                                    background: 'transparent', cursor: 'pointer', textAlign: 'left',
                                    fontFamily: t.font.family, minHeight: 72,
                                }}
                            >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                        <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.mono }}>
                                            {it.odoo_order_name}
                                        </span>
                                        <Badge tone={est.tone} dot>{est.label}</Badge>
                                    </div>
                                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {it.partner_name || 'Sin cliente'}
                                    </div>
                                    <div style={{ fontSize: 11, color: t.color.textFaint, marginTop: 4, ...t.numericStyle }}>
                                        {fmtFecha(it.date_order)} · {it.n_items} ítems · {hecha}/{pedida} u.{it.odoo_picking_name ? ` · ${it.odoo_picking_name}` : ''}
                                    </div>
                                </div>
                                <Icon.ChevronRight size={18} />
                            </button>
                        );
                    })}
                </Card>
            )}
        </div>
    );
}
