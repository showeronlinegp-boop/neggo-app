import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import * as Icon from '../../components/common/icons';

const MODULES = ['auth', 'suppliers', 'products', 'scraping', 'alerts', 'preventas', 'users', 'catalogs', 'mappings'];
const MODULE_OPTIONS = [
    { value: '', label: 'Todos los módulos' },
    ...MODULES.map(m => ({ value: m, label: m })),
];

export default function ActivityLog() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [users, setUsers] = useState([]);
    const [filterUser, setFilterUser] = useState('');
    const [filterModule, setFilterModule] = useState('');
    const [filterAction, setFilterAction] = useState('');
    const [filterFrom, setFilterFrom] = useState('');
    const [filterTo, setFilterTo] = useState('');
    const [detail, setDetail] = useState(null);

    useEffect(() => {
        api.get('/users', { limit: 100 }).then(r => r.success && setUsers(r.data || []));
    }, []);

    useEffect(() => { setPage(1); }, [filterUser, filterModule, filterAction, filterFrom, filterTo]);
    useEffect(() => { fetchData(); }, [page, filterUser, filterModule, filterAction, filterFrom, filterTo]);

    async function fetchData() {
        setLoading(true);
        const params = { limit: 50, offset: (page - 1) * 50 };
        if (filterUser)   params.user_id = filterUser;
        if (filterModule) params.module = filterModule;
        if (filterAction) params.action = filterAction;
        if (filterFrom)   params.from = filterFrom;
        if (filterTo)     params.to = filterTo + 'T23:59:59';
        const res = await api.get('/activity-log', params);
        if (res.success) { setData(res.data || []); setTotal(res.pagination?.total || res.data?.length || 0); }
        else showToast(res.error || 'Error al cargar log', 'error');
        setLoading(false);
    }

    function clearFilters() {
        setFilterUser(''); setFilterModule(''); setFilterAction(''); setFilterFrom(''); setFilterTo('');
    }

    const hasFilters = filterUser || filterModule || filterAction || filterFrom || filterTo;

    const userOptions = [
        { value: '', label: 'Todos los usuarios' },
        ...users.map(u => ({ value: String(u.id), label: u.display_name })),
    ];

    // Input date estilizado con tokens
    const dateInputStyle = {
        padding: `0 12px`,
        height: t.layout.inputHeight,
        border: `1px solid ${t.color.borderStrong}`,
        borderRadius: t.radius.sm,
        fontSize: t.font.size.sm,
        fontFamily: t.font.family,
        color: t.color.text,
        background: t.color.surface,
        boxSizing: 'border-box',
    };

    const cols = [
        {
            key: 'created_at',
            label: 'Fecha',
            render: v => (
                <span style={{ fontSize: t.font.size.xs, fontFamily: t.font.mono, color: t.color.textMuted, whiteSpace: 'nowrap' }}>
                    {new Date(v).toLocaleString('es-AR')}
                </span>
            ),
        },
        {
            key: 'user_display_name',
            label: 'Usuario',
            render: (v, row) => (
                <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }} title={row.username}>
                    {v || row.username || '—'}
                </span>
            ),
        },
        {
            key: 'module',
            label: 'Módulo',
            render: v => <Badge tone="primary">{v}</Badge>,
        },
        {
            key: 'action',
            label: 'Acción',
            render: v => <Badge tone="muted">{v}</Badge>,
        },
        {
            key: 'entity_type',
            label: 'Entidad',
            render: (v, row) => v
                ? <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>{v} #{row.entity_id || '?'}</span>
                : <span style={{ color: t.color.textFaint }}>—</span>,
        },
        {
            key: 'ip_address',
            label: 'IP',
            render: v => v
                ? <span style={{ fontSize: t.font.size.xs, fontFamily: t.font.mono, color: t.color.textFaint }}>{v}</span>
                : <span style={{ color: t.color.textFaint }}>—</span>,
        },
        {
            key: 'metadata',
            label: '',
            render: (v, row) => v && Object.keys(v).length > 0
                ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={e => { e.stopPropagation(); setDetail(row); }}
                    >
                        Ver detalle
                    </Button>
                )
                : null,
        },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Filtros */}
            <Card padding={false} style={{ padding: t.space[5] }}>
                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', alignItems: 'center' }}>
                    <Select
                        value={filterUser}
                        onChange={setFilterUser}
                        options={userOptions}
                        style={{ width: 180 }}
                    />
                    <Select
                        value={filterModule}
                        onChange={setFilterModule}
                        options={MODULE_OPTIONS}
                        style={{ width: 160 }}
                    />
                    <Input
                        value={filterAction}
                        onChange={e => setFilterAction(e.target.value)}
                        placeholder="Acción…"
                        style={{ width: 140 }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap', fontFamily: t.font.family }}>Desde</span>
                        <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} style={dateInputStyle} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap', fontFamily: t.font.family }}>Hasta</span>
                        <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} style={dateInputStyle} />
                    </div>
                    {hasFilters && (
                        <Button size="sm" variant="ghost" leftIcon={<Icon.X size={13} />} onClick={clearFilters}>
                            Limpiar
                        </Button>
                    )}
                    {total > 0 && (
                        <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginLeft: 'auto', fontFamily: t.font.family, ...t.numericStyle }}>
                            {total.toLocaleString('es-AR')} registros
                        </span>
                    )}
                </div>
            </Card>

            <DataTable
                columns={cols}
                data={data}
                loading={loading}
                pagination={{ page, pageSize: 50, total }}
                onPageChange={setPage}
            />

            {/* Modal detalle metadata */}
            <Modal
                isOpen={!!detail}
                onClose={() => setDetail(null)}
                title={detail ? `${detail.module} / ${detail.action}` : ''}
                subtitle={detail ? `${detail.user_display_name || detail.username || '—'} · ${detail.created_at ? new Date(detail.created_at).toLocaleString('es-AR') : ''}` : ''}
                size="md"
            >
                {detail && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
                        {detail.entity_type && (
                            <div style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                                Entidad: <span style={{ fontWeight: t.font.weight.semibold }}>{detail.entity_type} #{detail.entity_id}</span>
                            </div>
                        )}
                        <div>
                            <div style={{ fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: t.space[2], fontFamily: t.font.family }}>
                                Metadata
                            </div>
                            <pre style={{
                                background: t.color.surface2,
                                border: `1px solid ${t.color.border}`,
                                borderRadius: t.radius.sm,
                                padding: t.space[5],
                                fontSize: t.font.size.xs,
                                fontFamily: t.font.mono,
                                color: t.color.text,
                                overflow: 'auto',
                                maxHeight: 320,
                                margin: 0,
                                lineHeight: 1.6,
                            }}>
                                {JSON.stringify(detail.metadata, null, 2)}
                            </pre>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}
