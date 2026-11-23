import { useState, useEffect, useRef } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

const PAGE = 8;

// Primeras palabras útiles del nombre del proveedor para arrancar la búsqueda en Odoo
function busquedaInicial(nombre) {
    return String(nombre || '')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !/^\d+$/.test(w))
        .slice(0, 2)
        .join(' ');
}

/**
 * Vínculos a Odoo de un producto de proveedor, con buscador para vincular desde el detalle
 * (nota 212). Usa el mismo vínculo manual que la pantalla Vínculos: POST /mappings.
 */
export default function VincularOdooDetalle({ product, companyInicial = 'neggo' }) {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();
    const { user } = useAuth();
    const puedeVincular = user?.role === 'admin' || user?.role === 'operador';

    const [vinculos, setVinculos] = useState([]);
    const [company, setCompany] = useState(companyInicial);
    const [search, setSearch] = useState(() => busquedaInicial(product.name));
    const [query, setQuery] = useState(search);
    const [resultados, setResultados] = useState([]);
    const [total, setTotal] = useState(0);
    const [buscando, setBuscando] = useState(false);
    const [vinculando, setVinculando] = useState(null);
    const pedido = useRef(0);

    useEffect(() => { cargarVinculos(); }, [product.id]);

    // Espera a que termine de tipear antes de buscar
    useEffect(() => {
        const id = setTimeout(() => setQuery(search.trim()), 350);
        return () => clearTimeout(id);
    }, [search]);

    useEffect(() => { if (puedeVincular) buscar(0, false); }, [company, query]);

    async function cargarVinculos() {
        // Vinculado = confirmado por una persona (activo o no: el activo es solo el habitual)
        const res = await api.get('/mappings', { supplierId: product.supplier_id, search: product.sku, status: 'confirmado' });
        if (res.success) setVinculos((res.data || []).filter(m => m.supplier_product_id === product.id));
    }

    async function buscar(offset, append) {
        const n = ++pedido.current;
        if (!query) { setResultados([]); setTotal(0); setBuscando(false); return; }
        setBuscando(true);
        const res = await api.get('/products/odoo', { company, search: query, estado: 'activos', limit: PAGE, offset });
        if (n !== pedido.current) return;
        setBuscando(false);
        if (!res.success) { showToast(res.error || 'Error al buscar en Odoo', 'error'); return; }
        const rows = res.data || [];
        setTotal(res.pagination?.total ?? rows.length);
        setResultados(prev => append ? [...prev, ...rows] : rows);
    }

    async function vincular(op) {
        setVinculando(op.odoo_id);
        const res = await api.post('/mappings', { supplierProductId: product.id, odooProductId: op.odoo_id, odooCompany: company });
        setVinculando(null);
        if (res.success) { showToast('Vínculo creado', 'success'); cargarVinculos(); }
        else showToast(res.error || 'Error al crear el vínculo', 'error');
    }

    const yaVinculado = op => vinculos.some(m => m.odoo_product_id === op.odoo_id && m.odoo_company === company);
    const titulo = { fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, marginBottom: t.space[3], color: t.color.text, fontFamily: t.font.family };
    const caja = { background: t.color.surface2, borderRadius: t.radius.sm, border: `1px solid ${t.color.border}`, overflow: 'hidden' };
    const fila = i => ({
        display: 'flex', alignItems: 'center', gap: t.space[3],
        padding: `${t.space[3]}px ${t.space[5]}px`,
        borderTop: i > 0 ? `1px solid ${t.color.border}` : 'none',
    });

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
            <div>
                <div style={titulo}>Vinculados a Odoo · {vinculos.length}</div>
                {vinculos.length === 0 ? (
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                        Todavía no está vinculado a ningún producto de Odoo.
                    </div>
                ) : (
                    <div style={caja}>
                        {vinculos.map((m, i) => (
                            <div key={m.id} style={fila(i)}>
                                <Badge tone={m.odoo_company === 'neggo' ? 'primary' : 'accent'} style={{ minWidth: 74, justifyContent: 'center' }}>
                                    {m.odoo_company || '—'}
                                </Badge>
                                <span style={{ flex: 1, fontSize: t.font.size.sm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.color.text, fontFamily: t.font.family }}>
                                    {m.odoo_product_name}
                                </span>
                                {m.active && <Badge tone="success">habitual</Badge>}
                                {m.odoo_internal_ref && (
                                    <span style={{ fontSize: t.font.size.xs, fontFamily: t.font.mono, color: t.color.textFaint }}>
                                        {m.odoo_internal_ref}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {puedeVincular && (
                <div>
                    <div style={titulo}>Vincular con un producto de Odoo</div>
                    <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', alignItems: 'center', marginBottom: t.space[3] }}>
                        <Input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Buscar en Odoo por nombre, referencia o código de barras…"
                            leftIcon={<Icon.Search size={15} />}
                            style={{ flex: '1 1 240px', minWidth: 180 }}
                        />
                        <div style={{ display: 'flex', background: t.color.surface2, borderRadius: t.radius.sm, padding: 3, border: `1px solid ${t.color.border}`, flexShrink: 0 }}>
                            {['neggo', 'preventas'].map(c => (
                                <button
                                    key={c}
                                    type="button"
                                    onClick={() => setCompany(c)}
                                    style={{
                                        padding: '0 14px', height: 32, borderRadius: t.radius.sm - 1,
                                        fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, fontFamily: t.font.family,
                                        background: company === c ? t.color.surface : 'transparent',
                                        color: company === c ? t.color.text : t.color.textMuted,
                                        boxShadow: company === c ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                                        textTransform: 'capitalize', cursor: 'pointer', border: 'none',
                                    }}
                                >
                                    {c}
                                </button>
                            ))}
                        </div>
                    </div>

                    {!query ? (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                            Escribí qué buscar en Odoo.
                        </div>
                    ) : resultados.length === 0 ? (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                            {buscando ? 'Buscando…' : 'No encontramos productos en Odoo con esa búsqueda.'}
                        </div>
                    ) : (
                        <div style={caja}>
                            {resultados.map((op, i) => {
                                const ya = yaVinculado(op);
                                return (
                                    <div key={op.odoo_id} style={fila(i)}>
                                        <ProductThumb imageUrl={op.image_url} emoji={op.name?.[0]} size={36} />
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: t.font.family }}>
                                                {op.name}
                                            </div>
                                            <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2, fontFamily: t.font.mono }}>
                                                {op.internal_ref || '—'}
                                                {op.standard_price != null && (
                                                    <span style={{ fontFamily: t.font.family, color: t.color.textMuted, ...t.numericStyle }}> · costo {fmtAR(op.standard_price)}</span>
                                                )}
                                            </div>
                                        </div>
                                        {ya ? (
                                            <Badge tone="success" dot>vinculado</Badge>
                                        ) : (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                leftIcon={<Icon.Link size={13} />}
                                                disabled={vinculando != null}
                                                onClick={() => vincular(op)}
                                            >
                                                {vinculando === op.odoo_id ? 'Vinculando…' : 'Vincular'}
                                            </Button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {resultados.length > 0 && resultados.length < total && (
                        <div style={{ marginTop: t.space[3], display: 'flex', justifyContent: 'center' }}>
                            <Button size="sm" variant="ghost" disabled={buscando} onClick={() => buscar(resultados.length, true)}>
                                {buscando ? 'Cargando…' : `Ver más (${(total - resultados.length).toLocaleString('es-AR')})`}
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
