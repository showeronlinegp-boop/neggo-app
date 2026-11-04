// Vincular un producto de la cola de reposición con ofertas web, sin salir de la pantalla.
// Usa la tabla maestra: confirmar un vínculo (POST /mappings) o rechazar un sugerido.
import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Modal from '../../components/common/Modal';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Badge from '../../components/common/Badge';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

// Dos primeras palabras del nombre, sin números ni símbolos, para buscar la oferta
// cuando el código no coincide. No se usan más: un error de tipeo más adelante
// (por ejemplo "Velociadades") dejaría la búsqueda en cero.
function palabrasNombre(name) {
    return String(name || '')
        .split(/\s+/)
        .map(w => w.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, ''))
        .filter(w => w.length > 3)
        .slice(0, 2)
        .join(' ');
}

function FilaOferta({ imagen, titulo, detalle, extra, accion, t }) {
    return (
        <div style={{
            display: 'flex', gap: 10, alignItems: 'center',
            padding: '8px 0', borderTop: `1px solid ${t.color.border}`,
        }}>
            <ProductThumb imageUrl={imagen} size={44} />
            <div style={{ flex: 1, minWidth: 0, fontFamily: t.font.family }}>
                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text }}>
                    {titulo}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2 }}>
                    {detalle}
                </div>
                {extra}
            </div>
            <div style={{ flexShrink: 0 }}>{accion}</div>
        </div>
    );
}

export default function VincularReposicionModal({ producto, onClose, onCambio }) {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const [q, setQ] = useState('');
    const [sugeridos, setSugeridos] = useState([]);
    const [confirmados, setConfirmados] = useState([]);
    const [resultados, setResultados] = useState([]);
    const [cargando, setCargando] = useState(false);
    const [buscando, setBuscando] = useState(false);
    const [trabajando, setTrabajando] = useState(null);
    const [error, setError] = useState(null);
    const [aviso, setAviso] = useState(null);

    const odooId = producto?.odoo_id;

    const cargarVinculos = useCallback(async () => {
        if (!odooId) return;
        setCargando(true);
        const base = { odooProductId: odooId, company: 'neggo', source: 'web', limit: 30 };
        const [sug, conf] = await Promise.all([
            api.get('/mappings', { ...base, status: 'sugerido' }),
            api.get('/mappings', { ...base, status: 'confirmado' }),
        ]);
        setCargando(false);
        if (!sug.success || !conf.success) {
            setError(sug.error || conf.error || 'No se pudieron leer los vínculos');
            return;
        }
        setSugeridos(sug.data || []);
        setConfirmados(conf.data || []);
    }, [odooId]);

    useEffect(() => {
        if (!producto) return;
        setQ(producto.internal_ref || '');
        setError(null);
        setAviso(null);
        setResultados([]);
        cargarVinculos();
    }, [producto, cargarVinculos]);

    useEffect(() => {
        const term = q.trim();
        if (!producto || term.length < 2) { setResultados([]); return; }
        let vivo = true;
        const timer = setTimeout(async () => {
            setBuscando(true);
            const res = await api.get('/products/supplier', { search: term, match: 'words', source: 'web', limit: 15 });
            if (!vivo) return;
            setBuscando(false);
            if (res.success) setResultados(res.data || []);
            else setError(res.error || 'No se pudo buscar');
        }, 300);
        return () => { vivo = false; clearTimeout(timer); };
    }, [q, producto]);

    if (!producto) return null;

    const idsConfirmados = new Set(confirmados.map(m => m.supplier_product_id));
    const idsSugeridos = new Set(sugeridos.map(m => m.supplier_product_id));
    const porNombre = palabrasNombre(producto.name);
    const ref = producto.internal_ref || '';

    async function vincular(supplierProductId) {
        setTrabajando(supplierProductId);
        setError(null);
        const res = await api.post('/mappings', {
            supplierProductId,
            odooProductId: odooId,
            odooCompany: 'neggo',
        });
        setTrabajando(null);
        if (!res.success) { setError(res.error || 'No se pudo vincular'); return; }
        setAviso('Vínculo confirmado. La oferta queda en esta reposición.');
        await cargarVinculos();
        onCambio?.();
    }

    async function rechazar(m) {
        setTrabajando(m.supplier_product_id);
        setError(null);
        const res = await api.post('/mappings/vincular/rechazar', {
            supplierProductId: m.supplier_product_id,
            odooProductId: odooId,
        });
        setTrabajando(null);
        if (!res.success) { setError(res.error || 'No se pudo rechazar'); return; }
        setAviso('Esa oferta no se vuelve a proponer para este producto.');
        await cargarVinculos();
    }

    return (
        <Modal
            isOpen
            onClose={onClose}
            title="Vincular oferta"
            subtitle={producto.name || `Producto ${odooId}`}
            width={640}
            fullScreen={isMobile}
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: t.font.family }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                    Buscá el mismo producto en el catálogo de un proveedor y confirmalo.
                    Queda en la tabla maestra y esta reposición muestra el precio.
                    {ref ? <> Código de Neggo: <span style={{ fontFamily: t.font.mono }}>{ref}</span>.</> : null}
                </div>

                {error && (
                    <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '8px 12px', borderRadius: t.radius.sm, fontSize: t.font.size.sm }}>
                        {error}
                    </div>
                )}
                {aviso && !error && (
                    <div style={{ background: t.color.successSoft, color: t.color.success, padding: '8px 12px', borderRadius: t.radius.sm, fontSize: t.font.size.sm }}>
                        {aviso}
                    </div>
                )}

                <div>
                    <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, marginBottom: 8 }}>
                        Buscar en catálogos
                    </div>
                    <Input
                        value={q}
                        onChange={e => setQ(e.target.value)}
                        placeholder="Nombre o código del proveedor"
                        leftIcon={<Icon.Search size={14} />}
                        autoFocus
                    />
                    {(ref || porNombre) && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                            {ref && (
                                <Button size="sm" variant={q === ref ? 'secondary' : 'ghost'} onClick={() => setQ(ref)}>
                                    {ref}
                                </Button>
                            )}
                            {porNombre && porNombre !== ref && (
                                <Button size="sm" variant={q === porNombre ? 'secondary' : 'ghost'} onClick={() => setQ(porNombre)}>
                                    {porNombre}
                                </Button>
                            )}
                        </div>
                    )}
                    {buscando && (
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 8 }}>Buscando…</div>
                    )}
                    {!buscando && q.trim().length >= 2 && resultados.length === 0 && (
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 8 }}>
                            No hay ofertas web con esas palabras.
                        </div>
                    )}
                    {resultados.map(p => {
                        const ya = idsConfirmados.has(p.id);
                        const sugerido = idsSugeridos.has(p.id);
                        return (
                            <FilaOferta
                                key={p.id}
                                t={t}
                                imagen={p.image_url}
                                titulo={p.name}
                                detalle={`${p.supplier_name} · ${p.sku || 'sin código'}${p.costo != null ? ` · ${fmtAR(p.costo)}` : ''}`}
                                extra={!p.available ? <Badge tone="muted">No disponible</Badge> : null}
                                accion={ya ? (
                                    <Badge tone="success">Vinculado</Badge>
                                ) : (
                                    <Button size="sm" variant="primary" leftIcon={<Icon.Link size={13} />}
                                        disabled={trabajando === p.id}
                                        onClick={() => vincular(p.id)}>
                                        {sugerido ? 'Confirmar' : 'Vincular'}
                                    </Button>
                                )}
                            />
                        );
                    })}
                </div>

                <div>
                    <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold }}>
                        Sugeridos {cargando ? '' : `· ${sugeridos.length}`}
                    </div>
                    {!cargando && sugeridos.length === 0 && (
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 6 }}>
                            No hay sugerencias pendientes para este producto.
                        </div>
                    )}
                    {sugeridos.map(m => (
                        <FilaOferta
                            key={m.id}
                            t={t}
                            imagen={m.supplier_image_url}
                            titulo={m.supplier_name}
                            detalle={`${m.supplier_name_full} · ${m.supplier_sku || 'sin código'}${m.raw_price != null ? ` · lista ${fmtAR(m.raw_price)}` : ''}`}
                            extra={m.metodo ? <Badge tone="warn">{m.metodo}</Badge> : null}
                            accion={(
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <Button size="sm" variant="primary" leftIcon={<Icon.Check size={13} />}
                                        disabled={trabajando === m.supplier_product_id}
                                        onClick={() => vincular(m.supplier_product_id)}>
                                        Confirmar
                                    </Button>
                                    <Button size="sm" variant="ghost"
                                        disabled={trabajando === m.supplier_product_id}
                                        onClick={() => rechazar(m)}>
                                        No es
                                    </Button>
                                </div>
                            )}
                        />
                    ))}
                </div>

                {confirmados.length > 0 && (
                    <div>
                        <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold }}>
                            Ya vinculados · {confirmados.length}
                        </div>
                        {confirmados.map(m => (
                            <FilaOferta
                                key={m.id}
                                t={t}
                                imagen={m.supplier_image_url}
                                titulo={m.supplier_name}
                                detalle={`${m.supplier_name_full} · ${m.supplier_sku || 'sin código'}`}
                                extra={m.es_habitual ? <Badge tone="success">Habitual</Badge> : null}
                                accion={<Badge tone="success">Vinculado</Badge>}
                            />
                        ))}
                    </div>
                )}
            </div>
        </Modal>
    );
}
