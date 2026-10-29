// Pestañas de la tabla maestra en /productos/vinculos (nota 107): lote por código, tarjetas por
// nombre, conflictos y sin habitual. Solo Neggo; ninguna decisión mueve precios ni escribe en Odoo,
// salvo "No usar" en conflictos (nota 118), que renombra y archiva el producto.
import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Toggle from '../../components/common/Toggle';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ProductThumb from '../../components/common/ProductThumb';
import FotoAmpliada from '../../components/common/FotoAmpliada';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import * as Icon from '../../components/common/icons';

// Diferencia entre el neto de la oferta y el costo de Odoo a partir de la cual se avisa (posible pack)
const DIFERENCIA_PRECIO = 0.3;
// Tamaño de las fotos de las tarjetas: la de Neggo y la de cada oferta, para compararlas
const FOTO_NEGGO = 120;
const FOTO_OFERTA = 96;

function diferenciaPrecio(neto, costo) {
    const n = Number(neto), c = Number(costo);
    if (!n || !c) return null;
    return n / c - 1;
}

// ─── Lote por código ─────────────────────────────────────────────────────────────
export function LoteCodigo({ tokens: t, onCambio }) {
    const { showToast } = useToast();
    const [filas, setFilas] = useState([]);
    const [cargando, setCargando] = useState(true);
    const [proveedor, setProveedor] = useState('');
    const [destildados, setDestildados] = useState(() => new Set());
    const [rechazarDestildados, setRechazarDestildados] = useState(false);
    const [guardando, setGuardando] = useState(false);

    const cargar = useCallback(async () => {
        setCargando(true);
        const res = await api.get('/mappings/vincular/lote');
        if (res.success) setFilas(res.data || []);
        else showToast(res.error || 'Error al cargar el lote', 'error');
        setDestildados(new Set());
        setCargando(false);
    }, [showToast]);

    useEffect(() => { cargar(); }, [cargar]);

    const proveedores = useMemo(() => {
        const cuenta = new Map();
        filas.forEach(f => cuenta.set(f.proveedor, (cuenta.get(f.proveedor) || 0) + 1));
        return [...cuenta.entries()];
    }, [filas]);

    const visibles = proveedor ? filas.filter(f => f.proveedor === proveedor) : filas;
    const tildados = visibles.filter(f => !destildados.has(f.id));

    function alternar(id) {
        setDestildados(prev => {
            const n = new Set(prev);
            if (n.has(id)) n.delete(id); else n.add(id);
            return n;
        });
    }

    function tildarTodos(valor) {
        setDestildados(prev => {
            const n = new Set(prev);
            visibles.forEach(f => (valor ? n.delete(f.id) : n.add(f.id)));
            return n;
        });
    }

    async function confirmar() {
        setGuardando(true);
        const res = await api.post('/mappings/vincular/lote', {
            confirmar: tildados.map(f => f.id),
            rechazar: rechazarDestildados ? visibles.filter(f => destildados.has(f.id)).map(f => f.id) : [],
        });
        setGuardando(false);
        if (res.success) {
            const { confirmados = 0, rechazados = 0 } = res.data || {};
            showToast(`${confirmados} vínculos confirmados${rechazados ? ` · ${rechazados} rechazados` : ''}`, 'success');
            cargar();
            onCambio?.();
        } else showToast(res.error || 'Error al confirmar el lote', 'error');
    }

    if (cargando) return <Centrado><LoadingSpinner size="md" color={t.color.primary} /></Centrado>;
    if (!filas.length) return <Vacio tokens={t} msg="No quedan sugeridos por código. ¡Listo!" />;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <Ayuda tokens={t}>
                La referencia de Neggo coincide con el código del proveedor (mismo proveedor). Vienen todos tildados:
                destildá los que no sean el mismo producto y confirmá. Los destildados quedan pendientes, salvo que
                actives "Rechazar los destildados".
            </Ayuda>

            <Card padding={false} style={{ padding: t.space[4] }}>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
                    <Chip tokens={t} activo={!proveedor} onClick={() => setProveedor('')}>Todos · {fmtInt(filas.length)}</Chip>
                    {proveedores.map(([nombre, n]) => (
                        <Chip key={nombre} tokens={t} activo={proveedor === nombre} onClick={() => setProveedor(nombre)}>
                            {nombre} · {fmtInt(n)}
                        </Chip>
                    ))}
                </div>
                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', alignItems: 'center', marginTop: t.space[4] }}>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family, ...t.numericStyle }}>
                        Tildados <b>{fmtInt(tildados.length)}</b> de {fmtInt(visibles.length)}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => tildarTodos(true)}>Tildar todos</Button>
                    <Button size="sm" variant="ghost" onClick={() => tildarTodos(false)}>Destildar todos</Button>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                        <Toggle size="sm" checked={rechazarDestildados} onChange={setRechazarDestildados} />
                        Rechazar los destildados
                    </label>
                    <div style={{ flex: 1 }} />
                    <Button
                        variant="primary"
                        leftIcon={<Icon.Check size={15} />}
                        disabled={guardando || (!tildados.length && !(rechazarDestildados && destildados.size))}
                        onClick={confirmar}
                    >
                        {guardando ? 'Guardando…' : `Confirmar ${fmtInt(tildados.length)}`}
                    </Button>
                </div>
            </Card>

            <Card padding={false} style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                    <thead>
                        <tr style={{ background: t.color.surface2 }}>
                            <Th tokens={t} />
                            <Th tokens={t}>Oferta del proveedor</Th>
                            <Th tokens={t}>Producto de Neggo</Th>
                            <Th tokens={t} right>Neto oferta</Th>
                            <Th tokens={t} right>Costo Odoo</Th>
                            <Th tokens={t} right>Venta 6 sem.</Th>
                        </tr>
                    </thead>
                    <tbody>
                        {visibles.map(f => {
                            const tildado = !destildados.has(f.id);
                            const dif = diferenciaPrecio(f.neto, f.standard_price);
                            return (
                                <tr
                                    key={f.id}
                                    onClick={() => alternar(f.id)}
                                    style={{ borderTop: `1px solid ${t.color.border}`, cursor: 'pointer', opacity: tildado ? 1 : 0.55 }}
                                >
                                    <Td tokens={t}>
                                        <input type="checkbox" checked={tildado} onChange={() => alternar(f.id)} onClick={e => e.stopPropagation()} />
                                    </Td>
                                    <Td tokens={t}>
                                        <Nombre tokens={t} nombre={f.oferta_nombre} codigo={f.sku} extra={f.proveedor} />
                                        {!f.available && <Badge tone="muted" style={{ marginTop: 4 }}>No disponible</Badge>}
                                    </Td>
                                    <Td tokens={t}>
                                        <Nombre tokens={t} nombre={f.odoo_nombre} codigo={f.internal_ref} />
                                        {f.odoo_activo === false && <Badge tone="muted" style={{ marginTop: 4 }}>Archivado</Badge>}
                                    </Td>
                                    <Td tokens={t} right>
                                        <span style={t.numericStyle}>{f.neto ? fmtAR(f.neto) : '—'}</span>
                                        {dif !== null && Math.abs(dif) > DIFERENCIA_PRECIO && (
                                            <div><Badge tone="warn" style={{ marginTop: 4 }}>{dif > 0 ? '+' : ''}{Math.round(dif * 100)} % ¿pack?</Badge></div>
                                        )}
                                    </Td>
                                    <Td tokens={t} right><span style={t.numericStyle}>{f.standard_price ? fmtAR(f.standard_price) : '—'}</span></Td>
                                    <Td tokens={t} right><span style={{ ...t.numericStyle, color: t.color.textMuted }}>{Number(f.venta) ? fmtAR(f.venta) : '—'}</span></Td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </Card>
        </div>
    );
}

// ─── Tarjetas por nombre ─────────────────────────────────────────────────────────
export function TarjetasNombre({ tokens: t, onCambio }) {
    const { showToast } = useToast();
    const [datos, setDatos] = useState(null);
    const [indice, setIndice] = useState(0);
    const [guardando, setGuardando] = useState(false);
    // Foto abierta en grande: { imageUrl, nombre, detalle }
    const [foto, setFoto] = useState(null);

    const cargar = useCallback(async () => {
        const res = await api.get('/mappings/vincular/tarjetas');
        if (res.success) { setDatos(res.data); setIndice(0); }
        else showToast(res.error || 'Error al cargar las tarjetas', 'error');
    }, [showToast]);

    useEffect(() => { cargar(); }, [cargar]);

    const tarjetas = datos?.tarjetas || [];
    const tarjeta = tarjetas[indice];

    const decidir = useCallback(async (mappingId) => {
        if (!tarjeta || guardando) return;
        setGuardando(true);
        const res = await api.post('/mappings/vincular/tarjetas', { odooProductId: tarjeta.odoo_product_id, mappingId });
        setGuardando(false);
        if (!res.success) return showToast(res.error || 'Error al guardar', 'error');
        showToast(mappingId ? 'Vínculo confirmado' : 'Ninguna: no se vuelven a proponer', 'success');
        onCambio?.();
        // Sale de la lista y queda una decisión más en la semana
        setDatos(d => ({
            ...d,
            tarjetas: d.tarjetas.filter(x => x.odoo_product_id !== tarjeta.odoo_product_id),
            decididas_semana: d.decididas_semana + 1,
            pendientes: Math.max(d.pendientes - 1, 0),
        }));
        setIndice(i => Math.min(i, Math.max(tarjetas.length - 2, 0)));
    }, [tarjeta, guardando, tarjetas.length, showToast, onCambio]);

    const saltear = useCallback(() => {
        if (tarjetas.length) setIndice(i => (i + 1) % tarjetas.length);
    }, [tarjetas.length]);

    // Teclado: 1/2/3 elige, N = ninguna, espacio = saltear
    useEffect(() => {
        function onKey(e) {
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
            // Con la foto ampliada abierta no se decide nada por teclado
            if (!tarjeta || foto) return;
            const n = parseInt(e.key, 10);
            if (n >= 1 && n <= tarjeta.ofertas.length) { e.preventDefault(); decidir(tarjeta.ofertas[n - 1].mapping_id); }
            else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); decidir(null); }
            else if (e.key === ' ') { e.preventDefault(); saltear(); }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [tarjeta, foto, decidir, saltear]);

    if (!datos) return <Centrado><LoadingSpinner size="md" color={t.color.primary} /></Centrado>;

    const encabezado = (
        <div style={{ display: 'flex', gap: t.space[3], alignItems: 'center', flexWrap: 'wrap', fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
            <span>Esta semana: <b style={{ color: t.color.text }}>{datos.decididas_semana}</b> de {datos.tope}</span>
            <span>· {fmtInt(datos.pendientes)} productos pendientes</span>
            {tarjetas.length > 0 && <span>· tarjeta {indice + 1} de {tarjetas.length}</span>}
        </div>
    );

    if (!tarjeta) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
                {encabezado}
                <Vacio tokens={t} msg={datos.pendientes > 0 && datos.decididas_semana >= datos.tope
                    ? `Llegaste al tope de ${datos.tope} tarjetas de esta semana. Las que faltan vuelven la semana que viene.`
                    : 'No quedan tarjetas por revisar.'} />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <Ayuda tokens={t}>
                Ofertas del mismo proveedor con nombre parecido, de lo que más se vende a lo que menos.
                Tocá <Tecla tokens={t}>1</Tecla> <Tecla tokens={t}>2</Tecla> <Tecla tokens={t}>3</Tecla> si es esa oferta,
                {' '}<Tecla tokens={t}>N</Tecla> si no es ninguna y <Tecla tokens={t}>espacio</Tecla> para saltearla.
            </Ayuda>
            {encabezado}

            <Card padding={false} style={{ padding: t.space[5] }}>
                <div style={{ display: 'flex', gap: t.space[3], alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <FotoBoton
                        tokens={t}
                        imageUrl={tarjeta.odoo_image_url}
                        nombre={tarjeta.odoo_nombre}
                        size={FOTO_NEGGO}
                        onAbrir={() => setFoto({ imageUrl: tarjeta.odoo_image_url, nombre: tarjeta.odoo_nombre, detalle: tarjeta.internal_ref })}
                    />
                    <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family }}>
                            Producto de Neggo
                        </div>
                        <div style={{ fontSize: 17, fontWeight: t.font.weight.semibold, color: t.color.text, marginTop: 4, fontFamily: t.font.family }}>
                            {tarjeta.odoo_nombre}
                        </div>
                        <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2 }}>
                            {tarjeta.internal_ref || 'sin referencia'}
                        </div>
                    </div>
                    <Dato tokens={t} titulo="Proveedor principal" valor={tarjeta.vendor_name || '—'} />
                    <Dato tokens={t} titulo="Costo Odoo" valor={tarjeta.standard_price ? fmtAR(tarjeta.standard_price) : '—'} numerico />
                    <Dato tokens={t} titulo="Venta 6 sem." valor={Number(tarjeta.venta) ? fmtAR(tarjeta.venta) : '—'} numerico />
                    {tarjeta.odoo_activo === false && <Badge tone="muted">Archivado</Badge>}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], marginTop: t.space[5] }}>
                    {tarjeta.ofertas.map((o, i) => {
                        const dif = diferenciaPrecio(o.neto, tarjeta.standard_price);
                        return (
                            <div
                                key={o.mapping_id}
                                style={{
                                    display: 'flex', gap: t.space[3], alignItems: 'center',
                                    padding: '10px 14px', borderRadius: t.radius.sm,
                                    border: `1px solid ${t.color.border}`, background: t.color.surface,
                                }}
                            >
                                {/* La foto va afuera del botón: tocarla la amplía sin elegir la oferta */}
                                <FotoBoton
                                    tokens={t}
                                    imageUrl={o.image_url}
                                    nombre={o.nombre}
                                    size={FOTO_OFERTA}
                                    onAbrir={() => setFoto({ imageUrl: o.image_url, nombre: o.nombre, detalle: [o.sku, o.proveedor].filter(Boolean).join(' · ') })}
                                />
                                <button
                                    type="button"
                                    disabled={guardando}
                                    onClick={() => decidir(o.mapping_id)}
                                    style={{
                                        flex: 1, minWidth: 0,
                                        display: 'flex', gap: t.space[3], alignItems: 'center', textAlign: 'left',
                                        padding: 0, border: 'none', background: 'transparent',
                                        cursor: guardando ? 'wait' : 'pointer', fontFamily: t.font.family,
                                    }}
                                >
                                    <Tecla tokens={t} grande>{i + 1}</Tecla>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <Nombre tokens={t} nombre={o.nombre} codigo={o.sku} extra={o.proveedor} />
                                    </div>
                                    <div style={{ textAlign: 'right', fontSize: t.font.size.sm, color: t.color.text }}>
                                        <div style={t.numericStyle}>{o.neto ? fmtAR(o.neto) : '—'}</div>
                                        {dif !== null && Math.abs(dif) > DIFERENCIA_PRECIO && (
                                            <Badge tone="warn" style={{ marginTop: 4 }}>{dif > 0 ? '+' : ''}{Math.round(dif * 100)} %</Badge>
                                        )}
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                                        {o.parecido != null && <Badge tone="primary">{Math.round(Number(o.parecido) * 100)} % parecido</Badge>}
                                        {!o.available && <Badge tone="muted">No disponible</Badge>}
                                    </div>
                                </button>
                            </div>
                        );
                    })}
                </div>

                <div style={{ display: 'flex', gap: t.space[3], marginTop: t.space[5], flexWrap: 'wrap' }}>
                    <Button variant="danger" leftIcon={<Icon.X size={15} />} disabled={guardando} onClick={() => decidir(null)}>
                        Ninguna (N)
                    </Button>
                    <Button variant="ghost" leftIcon={<Icon.ArrowRight size={15} />} disabled={guardando || tarjetas.length < 2} onClick={saltear}>
                        Saltear (espacio)
                    </Button>
                </div>
            </Card>

            <FotoAmpliada
                imageUrl={foto?.imageUrl}
                nombre={foto?.nombre}
                detalle={foto?.detalle}
                onClose={() => setFoto(null)}
            />
        </div>
    );
}

// Foto de la tarjeta: se toca para verla en grande (sin foto, solo la inicial)
function FotoBoton({ tokens: t, imageUrl, nombre, size, onAbrir }) {
    const thumb = <ProductThumb imageUrl={imageUrl} emoji={nombre?.[0]} size={size} />;
    if (!imageUrl) return thumb;
    return (
        <button
            type="button"
            onClick={onAbrir}
            title="Ver foto en grande"
            aria-label={`Ver foto de ${nombre || 'producto'}`}
            style={{ padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in', flexShrink: 0, borderRadius: t.radius.sm }}
        >
            {thumb}
        </button>
    );
}

// ─── Conflictos ──────────────────────────────────────────────────────────────────
export function Conflictos({ tokens: t, onCambio }) {
    const { showToast } = useToast();
    const { user } = useAuth();
    const esAdmin = user?.role === 'admin';
    const [filas, setFilas] = useState(null);
    const [noUsar, setNoUsar] = useState(null);
    const [marcando, setMarcando] = useState(false);

    const cargar = useCallback(async () => {
        const res = await api.get('/mappings/vincular/conflictos');
        if (res.success) setFilas(res.data || []);
        else showToast(res.error || 'Error al cargar los conflictos', 'error');
    }, [showToast]);

    useEffect(() => { cargar(); }, [cargar]);

    async function noEsEste(supplierProductId, odooProductId) {
        const res = await api.post('/mappings/vincular/rechazar', { supplierProductId, odooProductId });
        if (res.success) { showToast('Vínculo rechazado', 'success'); cargar(); onCambio?.(); }
        else showToast(res.error || 'Error al rechazar', 'error');
    }

    // "No usar" (nota 118): leyenda en el nombre + archivado en Odoo; la app deja de traerlo
    async function marcarNoUsar() {
        if (!noUsar || marcando) return;
        setMarcando(true);
        const res = await api.post('/mappings/vincular/no-usar', { odooProductId: noUsar.odoo_id });
        setMarcando(false);
        setNoUsar(null);
        if (res.success) { showToast(`"${res.data.nombre}" quedó fuera de la app`, 'success'); cargar(); onCambio?.(); }
        else showToast(res.error || 'Error al marcar No usar', 'error');
    }

    if (!filas) return <Centrado><LoadingSpinner size="md" color={t.color.primary} /></Centrado>;
    if (!filas.length) return <Vacio tokens={t} msg="No hay conflictos." />;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <Ayuda tokens={t}>
                Una misma oferta quedó confirmada con dos o más productos de Neggo. Suele ser un producto duplicado en
                Odoo o un código que el proveedor reusó. Tocá "No es este" en el que no corresponda. Si es un
                duplicado que no se usa más, "No usar" lo marca en Odoo y la app deja de traerlo.
            </Ayuda>
            {filas.map(c => (
                <Card key={c.supplier_product_id} padding={false} style={{ padding: t.space[5] }}>
                    <Nombre tokens={t} nombre={c.name} codigo={c.sku} extra={c.proveedor} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], marginTop: t.space[4] }}>
                        {c.productos.map(p => (
                            <div key={p.odoo_id} style={{
                                display: 'flex', gap: t.space[3], alignItems: 'center', flexWrap: 'wrap',
                                padding: '10px 12px', borderRadius: t.radius.sm, border: `1px solid ${t.color.border}`,
                            }}>
                                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                                    <Nombre tokens={t} nombre={p.nombre} codigo={p.internal_ref} extra={p.vendor_name ? `principal: ${p.vendor_name}` : null} />
                                </div>
                                {p.activo === false && <Badge tone="muted">Archivado</Badge>}
                                <Badge tone="muted">{p.metodo}</Badge>
                                {esAdmin && (
                                    <Button size="sm" variant="ghost" disabled={marcando} onClick={() => setNoUsar(p)}
                                        title='Le pone "[NO USAR]" al nombre en Odoo, lo archiva y la app deja de traerlo'>
                                        No usar
                                    </Button>
                                )}
                                <Button size="sm" variant="danger" onClick={() => noEsEste(c.supplier_product_id, p.odoo_id)}>No es este</Button>
                            </div>
                        ))}
                    </div>
                </Card>
            ))}

            <ConfirmDialog
                isOpen={!!noUsar}
                onClose={() => setNoUsar(null)}
                onConfirm={marcarNoUsar}
                title="Marcar como No usar"
                message={`En Odoo, "${noUsar?.nombre}" pasa a llamarse "[NO USAR] ${noUsar?.nombre}" y queda archivado (precio, foto y categoría no se tocan). La app deja de traerlo y se rechazan todos sus vínculos. Para recuperarlo, sacale la leyenda al nombre en Odoo.`}
                confirmLabel={marcando ? 'Marcando…' : 'Marcar No usar'}
                danger
            />
        </div>
    );
}

// ─── Sin habitual (informativo) ──────────────────────────────────────────────────
export function SinHabitual({ tokens: t }) {
    const { showToast } = useToast();
    const [filas, setFilas] = useState(null);

    useEffect(() => {
        api.get('/mappings/vincular/sin-habitual').then(res => {
            if (res.success) setFilas(res.data || []);
            else showToast(res.error || 'Error al cargar', 'error');
        });
    }, [showToast]);

    if (!filas) return <Centrado><LoadingSpinner size="md" color={t.color.primary} /></Centrado>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <Ayuda tokens={t}>
                Productos con oferta vinculada pero sin proveedor habitual. El habitual es la oferta del proveedor
                principal de Odoo: si el principal no tiene oferta vinculada, el scraping no le va a mover el precio.
                Es solo para mirar; se arregla cambiando el principal en Odoo o vinculando una oferta de ese proveedor.
            </Ayuda>
            {!filas.length ? <Vacio tokens={t} msg="Todos los productos con oferta tienen habitual." /> : (
                <Card padding={false} style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                        <thead>
                            <tr style={{ background: t.color.surface2 }}>
                                <Th tokens={t}>Producto de Neggo</Th>
                                <Th tokens={t}>Principal en Odoo</Th>
                                <Th tokens={t}>Ofertas vinculadas de</Th>
                                <Th tokens={t} right>Venta 6 sem.</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {filas.map(f => (
                                <tr key={f.odoo_id} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                    <Td tokens={t}>
                                        <Nombre tokens={t} nombre={f.odoo_nombre} codigo={f.internal_ref} />
                                        {f.odoo_activo === false && <Badge tone="muted" style={{ marginTop: 4 }}>Archivado</Badge>}
                                    </Td>
                                    <Td tokens={t}>{f.vendor_name || <span style={{ color: t.color.textFaint }}>sin principal</span>}</Td>
                                    <Td tokens={t}>{(f.proveedores_vinculados || []).join(', ')}</Td>
                                    <Td tokens={t} right><span style={{ ...t.numericStyle, color: t.color.textMuted }}>{Number(f.venta) ? fmtAR(f.venta) : '—'}</span></Td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Card>
            )}
        </div>
    );
}

// ─── Piezas chicas ───────────────────────────────────────────────────────────────
function Nombre({ tokens: t, nombre, codigo, extra }) {
    return (
        <div style={{ minWidth: 0 }}>
            <div style={{ color: t.color.text, fontWeight: t.font.weight.medium, fontFamily: t.font.family, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {nombre || '—'}
            </div>
            <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2, fontFamily: t.font.family }}>
                <span style={{ fontFamily: t.font.mono }}>{codigo || '—'}</span>
                {extra && <> · {extra}</>}
            </div>
        </div>
    );
}

function Dato({ tokens: t, titulo, valor, numerico }) {
    return (
        <div style={{ minWidth: 110 }}>
            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>{titulo}</div>
            <div style={{ fontSize: t.font.size.sm, color: t.color.text, fontWeight: t.font.weight.medium, marginTop: 2, fontFamily: t.font.family, ...(numerico ? t.numericStyle : {}) }}>
                {valor}
            </div>
        </div>
    );
}

function Tecla({ tokens: t, children, grande }) {
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minWidth: grande ? 28 : 20, height: grande ? 28 : 20, padding: '0 6px',
            borderRadius: t.radius.sm, border: `1px solid ${t.color.borderStrong}`, background: t.color.surface2,
            fontFamily: t.font.mono, fontSize: grande ? t.font.size.sm : t.font.size.xs, color: t.color.text,
            fontWeight: t.font.weight.semibold, flexShrink: 0,
        }}>
            {children}
        </span>
    );
}

function Chip({ tokens: t, activo, onClick, children }) {
    return (
        <button type="button" onClick={onClick} style={{
            padding: '0 12px', height: 28, borderRadius: t.radius.full,
            border: `1px solid ${activo ? t.color.primary : t.color.border}`,
            background: activo ? t.color.primarySoft : t.color.surface,
            color: activo ? t.color.primary : t.color.textMuted,
            fontSize: t.font.size.xs, fontWeight: t.font.weight.medium, fontFamily: t.font.family,
            cursor: 'pointer', ...t.numericStyle,
        }}>
            {children}
        </button>
    );
}

function Ayuda({ tokens: t, children }) {
    return (
        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, lineHeight: 1.5 }}>
            {children}
        </div>
    );
}

function Th({ children, tokens: t, right }) {
    return (
        <th style={{
            padding: '10px 14px', textAlign: right ? 'right' : 'left',
            fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', fontFamily: t.font.family,
        }}>
            {children}
        </th>
    );
}

function Td({ children, tokens: t, right }) {
    return (
        <td style={{ padding: '10px 14px', color: t.color.text, fontFamily: t.font.family, textAlign: right ? 'right' : 'left', verticalAlign: 'top' }}>
            {children}
        </td>
    );
}

function Centrado({ children }) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>{children}</div>;
}

function Vacio({ tokens: t, msg }) {
    return (
        <div style={{ padding: '40px 24px', textAlign: 'center', fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>
            {msg}
        </div>
    );
}
