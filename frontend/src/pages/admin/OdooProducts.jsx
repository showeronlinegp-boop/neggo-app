import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import useIsMobile from '../../hooks/useIsMobile';
import { fmtAR } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Toggle from '../../components/common/Toggle';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import FotoAmpliada from '../../components/common/FotoAmpliada';
import MiniaturaFoto from '../../components/common/MiniaturaFoto';
import * as Icon from '../../components/common/icons';

const fmtDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const LIMIT = 50;

export default function OdooProducts() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const { user } = useAuth();

    const [company, setCompany] = useState('neggo');
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [includeInactive, setIncludeInactive] = useState(false);
    const [page, setPage] = useState(0);
    const [products, setProducts] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [aviso, setAviso] = useState(null);
    const [lastSync, setLastSync] = useState(null);
    const [trabajando, setTrabajando] = useState(null);
    const [confirmar, setConfirmar] = useState(null);
    const [foto, setFoto] = useState(null);
    const [subiendoFoto, setSubiendoFoto] = useState(null);
    const cerrarFoto = useCallback(() => setFoto(null), []);

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const res = await api.get('/products/odoo', {
                company, search: search || undefined,
                include_inactive: includeInactive ? 'true' : 'false',
                limit: LIMIT, offset: page * LIMIT,
            });
            if (res.success) {
                const rows = res.data?.data || res.data || [];
                setProducts(rows); setTotal(res.pagination?.total || 0);
                if (rows.length > 0 && rows[0].synced_at) setLastSync(rows[0].synced_at);
            } else setError(res.error || 'Error cargando productos');
        } catch (err) { setError(err.message); }
        finally { setLoading(false); }
    }, [company, search, includeInactive, page]);

    useEffect(() => { load(); }, [load]);

    const reponer = async (p) => {
        setTrabajando(p.odoo_id); setError(null); setAviso(null);
        const res = await api.post('/reposicion', { odoo_id: p.odoo_id });
        setTrabajando(null);
        if (!res.success) { setError(res.error || 'No se pudo marcar para reponer'); return; }
        const como = res.data?.origen === 'archivado' ? 'agotado' : 'queda poco';
        setAviso(`«${p.name}» entró a Reposición como «${como}».`);
    };

    // Misma carga que en Reposición: escribe la foto en Odoo Neggo
    const subirFoto = async (p, file) => {
        if (!file) return;
        setSubiendoFoto(p.odoo_id); setError(null); setAviso(null);
        const form = new FormData();
        form.append('image', file);
        const res = await api.post(`/reposicion/foto/${p.odoo_id}`, form);
        setSubiendoFoto(null);
        if (!res.success) { setError(res.error || 'No se pudo cargar la foto en Odoo'); return; }
        // Cache-buster: la URL del template puede ser la misma que antes de tener foto
        const imageUrl = res.data?.image_url ? `${res.data.image_url}?v=${Date.now()}` : null;
        if (imageUrl) setProducts(prev => prev.map(x => x.odoo_id === p.odoo_id ? { ...x, image_url: imageUrl } : x));
        setAviso(`Foto de «${p.name}» cargada en Odoo.`);
    };

    // Cargar foto escribe en Odoo: solo admin y solo Neggo (el endpoint no sabe escribir en Preventas)
    const puedeSubirFoto = user?.role === 'admin' && company === 'neggo';

    const confirmarOdoo = async () => {
        const { tipo, p } = confirmar || {};
        if (!p) return;
        setConfirmar(null);
        setTrabajando(p.odoo_id); setError(null); setAviso(null);
        let res;
        if (company === 'neggo' && tipo === 'activar') {
            res = await api.post('/reposicion/activar', { odoo_id: p.odoo_id });
        } else if (company === 'neggo' && tipo === 'archivar') {
            res = await api.post('/reposicion/archivar', { odoo_id: p.odoo_id });
        } else {
            res = await api.patch(`/products/odoo/${p.odoo_id}/archive`, { company, archived: tipo === 'archivar' });
        }
        setTrabajando(null);
        if (!res.success) { setError(res.error || 'No se pudo actualizar en Odoo'); return; }
        setProducts(prev => prev.map(x => x.odoo_id === p.odoo_id
            ? { ...x, active: tipo === 'activar', locally_archived: tipo === 'archivar' }
            : x));
        if (tipo === 'activar') {
            setAviso(res.data?.cola_cerrada
                ? `«${p.name}» volvió a estar activo y en el Punto de Venta. Salió de la lista de Reposición.`
                : `«${p.name}» volvió a estar activo en Odoo.`);
        } else {
            setAviso(company === 'neggo'
                ? `«${p.name}» se archivó y fue a Reposición como agotado.`
                : `«${p.name}» archivado en Odoo Preventas.`);
        }
        if (!includeInactive && tipo === 'archivar') {
            setProducts(prev => prev.filter(x => x.odoo_id !== p.odoo_id));
        }
    };

    useEffect(() => {
        const timer = setTimeout(() => { setSearch(searchInput); setPage(0); }, 350);
        return () => clearTimeout(timer);
    }, [searchInput]);

    const totalPages = Math.ceil(total / LIMIT);

    const thStyle = {
        padding: '10px 12px', textAlign: 'left',
        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
        color: t.color.textMuted, background: t.color.surface2,
        borderBottom: `1px solid ${t.color.border}`,
        whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
        fontFamily: t.font.family, position: 'sticky', top: 0,
    };
    const tdStyle = {
        padding: '9px 12px', fontSize: t.font.size.sm,
        color: t.color.text, borderBottom: `1px solid ${t.color.border}`,
        verticalAlign: 'middle', fontFamily: t.font.family,
    };

    // Botones de cada producto: los usan la tabla y la lista del celu
    const acciones = (p, enCelu) => {
        const ancho = enCelu ? { flex: 1 } : undefined;
        return (
            <div style={{ display: enCelu ? 'flex' : 'inline-flex', gap: t.space[2] }}>
                {company === 'neggo' && (
                    <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={13} />} style={ancho}
                        disabled={trabajando === p.odoo_id} onClick={() => reponer(p)}>
                        Reponer
                    </Button>
                )}
                {p.active ? (
                    <Button size="sm" variant="danger" leftIcon={<Icon.Archive size={13} />} style={ancho}
                        disabled={trabajando === p.odoo_id} onClick={() => setConfirmar({ tipo: 'archivar', p })}>
                        Archivar
                    </Button>
                ) : (
                    <Button size="sm" variant="success" leftIcon={<Icon.Check size={13} />} style={ancho}
                        disabled={trabajando === p.odoo_id} onClick={() => setConfirmar({ tipo: 'activar', p })}>
                        Activar
                    </Button>
                )}
            </div>
        );
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Cabecera */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: t.space[3] }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                    <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{total.toLocaleString('es-AR')}</span> productos
                    {lastSync && <span style={{ marginLeft: t.space[3] }}>· Sync: {fmtDate(lastSync)}</span>}
                </div>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    {company === 'neggo' && (
                        <Link to="/reposicion" style={{ textDecoration: 'none' }}>
                            <Button size="sm" variant="secondary" leftIcon={<Icon.Package size={13} />}>
                                Ir a Reposición
                            </Button>
                        </Link>
                    )}
                    <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} onClick={load}>
                        Actualizar
                    </Button>
                </div>
            </div>

            {/* Filtros */}
            <Card padding={false} style={{ padding: t.space[5] }}>
                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', alignItems: 'center' }}>
                    {/* Pill empresa */}
                    <div style={{ display: 'flex', background: t.color.surface2, borderRadius: t.radius.sm, padding: 3, border: `1px solid ${t.color.border}` }}>
                        {['neggo', 'preventas'].map(c => (
                            <button key={c} type="button" onClick={() => { setCompany(c); setPage(0); }}
                                style={{
                                    padding: '0 16px', height: 30, borderRadius: t.radius.sm - 1,
                                    fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
                                    fontFamily: t.font.family, textTransform: 'capitalize', cursor: 'pointer',
                                    background: company === c ? t.color.surface : 'transparent',
                                    color: company === c ? t.color.text : t.color.textMuted,
                                    boxShadow: company === c ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                                }}
                            >{c}</button>
                        ))}
                    </div>
                    <Input
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                        placeholder="Buscar por nombre o referencia…"
                        leftIcon={<Icon.Search size={14} />}
                        style={{ flex: '1 1 240px', minWidth: 180 }}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: t.space[2], fontSize: t.font.size.sm, color: t.color.textMuted, cursor: 'pointer', fontFamily: t.font.family }}>
                        <Toggle checked={includeInactive} onChange={v => { setIncludeInactive(v); setPage(0); }} size="sm" />
                        Incluir inactivos
                    </label>
                </div>
            </Card>

            {/* Error */}
            {error && (
                <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '12px 16px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {error}
                </div>
            )}
            {aviso && !error && (
                <div style={{ background: t.color.successSoft, color: t.color.success, padding: '10px 16px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {aviso}
                </div>
            )}

            {/* Tabla */}
            <Card padding={false} style={{ overflow: 'hidden' }}>
                {loading ? (
                    <div style={{ padding: 60, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>
                        Cargando…
                    </div>
                ) : products.length === 0 ? (
                    <div style={{ padding: 60, textAlign: 'center', color: t.color.textFaint }}>
                        <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
                        <div style={{ fontWeight: t.font.weight.medium, fontFamily: t.font.family, color: t.color.textMuted }}>
                            No hay productos{search ? ' que coincidan con la búsqueda' : ''}
                        </div>
                    </div>
                ) : isMobile ? (
                    // En el celu la tabla no entra: una tarjeta por producto con los botones a la vista
                    <div>
                        {products.map((p, i) => (
                            <div key={p.id} style={{ padding: t.space[3], borderTop: i ? `1px solid ${t.color.border}` : 'none', display: 'flex', flexDirection: 'column', gap: t.space[2], fontFamily: t.font.family }}>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: t.space[3] }}>
                                    <MiniaturaFoto p={p} size={56} onVerFoto={setFoto}
                                        onSubirFoto={puedeSubirFoto ? subirFoto : null} subiendoFoto={subiendoFoto} />
                                    <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: t.space[2] }}>
                                            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, minWidth: 0 }}>{p.name}</div>
                                            <Badge tone={p.active ? 'success' : 'muted'} dot>{p.active ? 'Activo' : 'Inactivo'}</Badge>
                                        </div>
                                        <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>{p.internal_ref || p.barcode || '—'}</div>
                                        <div style={{ display: 'flex', gap: t.space[4], fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>
                                            <span>PVP <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.primary }}>{fmtAR(p.list_price)}</span></span>
                                            <span>Stock <span style={{ fontSize: t.font.size.sm, color: t.color.text }}>{p.qty_available != null ? Number(p.qty_available).toLocaleString('es-AR') : '—'}</span></span>
                                        </div>
                                    </div>
                                </div>
                                {acciones(p, true)}
                            </div>
                        ))}
                    </div>
                ) : (
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    <th style={{ ...thStyle, width: 1 }}>Foto</th>
                                    <th style={thStyle}>ID Odoo</th>
                                    <th style={thStyle}>Nombre</th>
                                    <th style={thStyle}>Referencia</th>
                                    <th style={thStyle}>Código barras</th>
                                    <th style={thStyle}>Categoría</th>
                                    <th style={{ ...thStyle, textAlign: 'right' }}>Costo</th>
                                    <th style={{ ...thStyle, textAlign: 'right' }}>PVP</th>
                                    <th style={{ ...thStyle, textAlign: 'right' }}>Stock</th>
                                    <th style={{ ...thStyle, textAlign: 'center' }}>Estado</th>
                                    <th style={thStyle}>Sync</th>
                                    <th style={{ ...thStyle, textAlign: 'right' }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {products.map(p => (
                                    <tr key={p.id}>
                                        <td style={{ ...tdStyle, padding: '6px 12px' }}>
                                            <MiniaturaFoto p={p} size={40} onVerFoto={setFoto}
                                                onSubirFoto={puedeSubirFoto ? subirFoto : null} subiendoFoto={subiendoFoto} />
                                        </td>
                                        <td style={{ ...tdStyle, fontFamily: t.font.mono, color: t.color.textFaint, fontSize: t.font.size.xs }}>{p.odoo_id}</td>
                                        <td style={{ ...tdStyle, fontWeight: t.font.weight.medium, maxWidth: 280 }}>
                                            <span title={p.name} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                                        </td>
                                        <td style={{ ...tdStyle, fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>{p.internal_ref || '—'}</td>
                                        <td style={{ ...tdStyle, fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>{p.barcode || '—'}</td>
                                        <td style={{ ...tdStyle, fontSize: t.font.size.xs, color: t.color.textMuted, maxWidth: 160 }}>
                                            <span title={p.categ_name} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.categ_name || '—'}</span>
                                        </td>
                                        <td style={{ ...tdStyle, textAlign: 'right', ...t.numericStyle, color: t.color.textMuted }}>{fmtAR(p.standard_price)}</td>
                                        <td style={{ ...tdStyle, textAlign: 'right', ...t.numericStyle, fontWeight: t.font.weight.semibold, color: t.color.primary }}>{fmtAR(p.list_price)}</td>
                                        <td style={{ ...tdStyle, textAlign: 'right', ...t.numericStyle }}>{p.qty_available != null ? Number(p.qty_available).toLocaleString('es-AR') : '—'}</td>
                                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                                            <Badge tone={p.active ? 'success' : 'muted'} dot>{p.active ? 'Activo' : 'Inactivo'}</Badge>
                                        </td>
                                        <td style={{ ...tdStyle, fontSize: t.font.size.xs, color: t.color.textFaint, whiteSpace: 'nowrap' }}>{fmtDate(p.synced_at)}</td>
                                        <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>{acciones(p, false)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            {/* Paginación */}
            {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                        Página {page + 1} de {totalPages}
                    </span>
                    <div style={{ display: 'flex', gap: t.space[2] }}>
                        <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>← Anterior</Button>
                        <Button size="sm" variant="secondary" disabled={page >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Siguiente →</Button>
                    </div>
                </div>
            )}

            <FotoAmpliada
                imageUrl={foto?.image_url}
                nombre={foto?.name}
                detalle={foto ? (foto.internal_ref || foto.barcode) : null}
                onClose={cerrarFoto}
            />

            <ConfirmDialog
                isOpen={!!confirmar}
                onClose={() => setConfirmar(null)}
                onConfirm={confirmarOdoo}
                danger={confirmar?.tipo === 'archivar'}
                title={confirmar?.tipo === 'activar' ? 'Activar en Odoo' : 'Archivar en Odoo'}
                confirmLabel={confirmar?.tipo === 'activar' ? 'Sí, activar' : 'Sí, archivar'}
                message={confirmar?.tipo === 'activar'
                    ? `«${confirmar?.p?.name || ''}» vuelve a estar activo en Odoo.${company === 'neggo' ? ' Si estaba en Reposición, queda como repuesto.' : ''}`
                    : (company === 'neggo'
                        ? `«${confirmar?.p?.name || ''}» se apaga en Odoo porque no queda stock y entra a Reposición como agotado.`
                        : `«${confirmar?.p?.name || ''}» se archiva en Odoo Preventas.`)}
            />
        </div>
    );
}
