import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';
import { descargarListasPDF, descargarPedidoPDF } from './pedidoPdf';
import {
    accesoDe,
    armarReparto,
    candidatosDe,
    claveNombre,
    coincideBusqueda,
    coincidenciasPorProveedor,
    estaRepartido,
    estaVinculado,
    filtrarSolapa,
    linkDelProducto,
    listaDelProveedor,
    listasParaPdf,
    ofertaMasBarata,
    partesDe,
    proveedoresDelPedido,
    qtyEn,
    vaA,
} from './pedidoDestino';
import { clienteCorto, esperasPorProducto, reponiblesDe, textoEspera } from './cotizacionesNeggo';

const ETIQUETA_ACCESO = {
    abierta: 'Catálogo web',
    clave: 'Web con clave',
    pdf: 'Solo PDF',
};

function qtyInicial(it) {
    const n = Number(it.qty_decidida ?? it.qty_sugerida);
    return Number.isInteger(n) && n > 0 ? n : 1;
}

function Thumb({ it, onVerFoto, size }) {
    if (!it.image_url) return <ProductThumb imageUrl={null} size={size} />;
    return (
        <button
            type="button"
            onClick={() => onVerFoto(it)}
            aria-label={`Ver foto de ${it.name || 'producto'}`}
            title="Ver foto en grande"
            style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', lineHeight: 0, flexShrink: 0 }}
        >
            <ProductThumb imageUrl={it.image_url} size={size} />
        </button>
    );
}

export default function ArmarPedido({
    items, cotizaciones = null, proveedorInicial = null, reponiendoCotiz = false, onReponerCotiz,
    isMobile, onVerFoto, onVincular, onVerCatalogo, onError, onAviso, onChanged,
}) {
    const { tokens: t } = useTheme();
    const [proveedor, setProveedor] = useState(proveedorInicial?.nombre ?? null);
    // A quién va cada producto, si se cambió a mano: { [id]: [{ destino, qty }] } (nota 187)
    const [asignaciones, setAsignaciones] = useState({});
    const [repartiendo, setRepartiendo] = useState(null);
    const [solapa, setSolapa] = useState('todos');
    const [elegidos, setElegidos] = useState({});
    const [qtys, setQtys] = useState({});
    const [accesos, setAccesos] = useState([]);
    const [trabajando, setTrabajando] = useState(false);
    // Qué PDF se está generando: 'tildados' | 'lista' | { n, total } (todas las listas)
    const [generandoPdf, setGenerandoPdf] = useState(null);
    // Buscador en todos los proveedores (nota 188)
    const [busqueda, setBusqueda] = useState('');
    const buscando = busqueda.trim().length > 0;

    useEffect(() => {
        let vivo = true;
        api.get('/reposicion/accesos').then(res => {
            if (vivo && res.success) setAccesos(res.data || []);
        });
        return () => { vivo = false; };
    }, []);

    useEffect(() => {
        setQtys(prev => {
            const next = { ...prev };
            for (const it of items) {
                if (next[it.id] == null) next[it.id] = qtyInicial(it);
            }
            return next;
        });
    }, [items]);

    const grupos = useMemo(() => proveedoresDelPedido(items, asignaciones), [items, asignaciones]);
    const coincidencias = useMemo(
        () => (buscando ? coincidenciasPorProveedor(items, busqueda, asignaciones) : null),
        [items, busqueda, buscando, asignaciones]
    );
    const gruposVisibles = useMemo(
        () => (coincidencias ? grupos.filter(g => coincidencias.has(g.nombre)) : grupos),
        [grupos, coincidencias]
    );
    // Productos distintos (uno repartido cuenta una sola vez)
    const totalCoincidencias = buscando ? items.filter(it => coincideBusqueda(it, busqueda)).length : 0;

    // Al buscar, si el proveedor abierto no tiene nada que coincida, salta al primero que sí
    useEffect(() => {
        if (!coincidencias || !gruposVisibles.length) return;
        if (!coincidencias.has(proveedor)) setProveedor(gruposVisibles[0].nombre);
    }, [coincidencias, gruposVisibles, proveedor]);

    useEffect(() => {
        if (!grupos.length) return;
        if (!grupos.some(g => g.nombre === proveedor)) {
            setProveedor(grupos.find(g => g.n > 0)?.nombre || grupos[0].nombre);
        }
    }, [grupos, proveedor]);

    // Desde Cotizaciones → «Armar pedido»: abre ese proveedor
    useEffect(() => {
        if (!proveedorInicial?.nombre) return;
        setProveedor(proveedorInicial.nombre);
        setSolapa('todos');
    }, [proveedorInicial]);

    // Lo que esperan los clientes en cotizaciones «Pendiente» de Neggo (nota 149)
    const esperas = useMemo(() => esperasPorProducto(cotizaciones), [cotizaciones]);
    const deCotizaciones = useMemo(() => reponiblesDe(cotizaciones, proveedor), [cotizaciones, proveedor]);

    const acceso = accesoDe(proveedor, accesos);
    const delProveedor = items.filter(it => vaA(it, proveedor, asignaciones[it.id]));
    // Lo que se le pide a este proveedor de cada producto (si está repartido, solo su parte)
    const qtyAca = (it) => qtyEn(it, proveedor, asignaciones[it.id], qtys[it.id]);
    // Primero lo que tiene un cliente esperando
    const visibles = filtrarSolapa(delProveedor, solapa)
        .filter(it => coincideBusqueda(it, busqueda))
        .sort((a, b) => Number(esperas.has(b.odoo_id)) - Number(esperas.has(a.odoo_id))
            || Number(estaVinculado(a)) - Number(estaVinculado(b))
            || String(a.name).localeCompare(String(b.name), 'es'));
    const sinAsignar = delProveedor.filter(it => !estaVinculado(it)).length;
    const vinculados = delProveedor.length - sinAsignar;
    const tildados = delProveedor.filter(it => elegidos[it.id]);

    const marcar = (id) => setElegidos(prev => ({ ...prev, [id]: !prev[id] }));

    // Todo el producto a otro proveedor (nota 187): cualquiera vinculado, aunque no sea más barato
    const mandarA = (it, destino) => {
        setAsignaciones(prev => ({ ...prev, [it.id]: [{ destino, qty: null }] }));
        setRepartiendo(null);
        if (destino !== proveedor) onAviso(`«${it.name}» ahora se le pide a ${destino}.`);
    };

    // Cantidad total del producto: si está repartido, la suma de las partes
    const totalDe = (it) => partesDe(it, asignaciones[it.id], qtys[it.id])
        .reduce((s, p) => s + (Number.isFinite(p.qty) ? p.qty : 0), 0);

    const guardarQty = async (it, total = Number(qtys[it.id])) => {
        const qty = Number(total);
        if (!Number.isInteger(qty) || qty < 0 || qty === Number(it.qty_decidida)) return;
        const res = await api.patch(`/reposicion/${it.id}`, { estado: 'pendiente', qty_decidida: qty });
        if (!res.success) onError(res.error || 'No se pudo guardar la cantidad');
    };

    // En un producto repartido, el campo de cantidad cambia solo la parte de este proveedor
    const cambiarQty = (it, valor) => {
        const asig = asignaciones[it.id];
        if (!estaRepartido(asig)) {
            setQtys(prev => ({ ...prev, [it.id]: valor }));
            return;
        }
        const nueva = asig.map(p => (p.destino === proveedor ? { ...p, qty: valor } : p));
        setAsignaciones(prev => ({ ...prev, [it.id]: nueva }));
    };

    const salirDeQty = (it) => {
        const asig = asignaciones[it.id];
        if (!estaRepartido(asig)) { guardarQty(it); return; }
        const total = totalDe(it);
        setQtys(prev => ({ ...prev, [it.id]: total }));
        guardarQty(it, total);
    };

    // «Repartir»: una cantidad por proveedor, se aplica con «Listo»
    const abrirReparto = (it) => {
        const cantidades = {};
        for (const c of candidatosDe(it)) cantidades[c.nombre] = '';
        for (const p of partesDe(it, asignaciones[it.id], qtys[it.id])) {
            cantidades[p.destino] = Number.isFinite(p.qty) ? String(p.qty) : '';
        }
        setRepartiendo({ id: it.id, cantidades });
    };

    const aplicarReparto = (it) => {
        const armado = armarReparto(repartiendo?.cantidades);
        if (!armado) { onError('Poné al menos una cantidad'); return; }
        onError(null);
        setAsignaciones(prev => ({ ...prev, [it.id]: armado.asignacion }));
        setQtys(prev => ({ ...prev, [it.id]: armado.total }));
        guardarQty(it, armado.total);
        setRepartiendo(null);
        const partes = armado.asignacion.length > 1
            ? armado.asignacion.map(p => `${p.destino} × ${fmtInt(p.qty)}`).join(' · ')
            : `todo a ${armado.asignacion[0].destino}`;
        onAviso(`«${it.name}»: ${partes}.`);
    };

    const pasarAEncargados = async () => {
        if (!tildados.length) { onError('Tildá al menos un producto'); return; }
        setTrabajando(true);
        onError(null);
        let ok = 0;
        for (const it of tildados) {
            // El encargado lleva la cantidad total, aunque esté repartida entre proveedores
            const qty = totalDe(it);
            const res = await api.patch(`/reposicion/${it.id}`, {
                estado: 'encargado',
                qty_decidida: Number.isInteger(qty) && qty >= 0 ? qty : undefined,
            });
            if (!res.success) {
                setTrabajando(false);
                onError(res.error || 'No se pudo pasar a encargados');
                if (ok) onChanged();
                return;
            }
            ok += 1;
        }
        setElegidos({});
        setTrabajando(false);
        onAviso(`${ok} producto${ok === 1 ? '' : 's'} de ${proveedor} pasó a encargados.`);
        onChanged();
    };

    // Quitar de la cola (nota 189): queda «descartado» y se puede volver a pendientes desde Resueltos
    const [quitando, setQuitando] = useState(null);
    const quitar = async (lista) => {
        if (!lista.length) { onError('Tildá al menos un producto'); return; }
        setQuitando(lista.length === 1 ? lista[0].id : 'tildados');
        onError(null);
        const res = await api.post('/reposicion/resolver', {
            estado: 'descartado',
            items: lista.map(it => ({ id: it.id })),
        });
        setQuitando(null);
        if (!res.success) { onError(res.error || 'No se pudo quitar'); return; }
        const ids = new Set(lista.map(it => it.id));
        const sinIds = (prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.has(Number(id))));
        setElegidos(sinIds);
        setAsignaciones(sinIds);
        if (repartiendo && ids.has(repartiendo.id)) setRepartiendo(null);
        const texto = lista.length === 1 ? `«${lista[0].name}» salió` : `${lista.length} productos salieron`;
        onAviso(`${texto} de reposición. Si te equivocaste, lo volvés a pendientes desde Resueltos.`);
        onChanged();
    };

    const pdf = async () => {
        const lista = tildados
            .map(it => ({ ...it, qty: qtyAca(it) }))
            .filter(it => it.qty > 0);
        if (!lista.length) { onError('Tildá al menos un producto con cantidad'); return; }
        setGenerandoPdf('tildados');
        onError(null);
        try {
            await descargarPedidoPDF(proveedor, lista);
        } catch (err) {
            onError(err.message || 'No se pudo generar el PDF');
        } finally {
            setGenerandoPdf(null);
        }
    };

    // Las listas no dependen de lo tildado: van con la cantidad que se ve en pantalla (nota 161)
    const listas = useMemo(() => listasParaPdf(items, asignaciones, qtys), [items, asignaciones, qtys]);
    const listaAbierta = useMemo(() => listaDelProveedor(items, proveedor, asignaciones, qtys), [items, proveedor, asignaciones, qtys]);

    const pdfLista = async () => {
        setGenerandoPdf('lista');
        onError(null);
        try {
            await descargarPedidoPDF(proveedor, listaAbierta);
        } catch (err) {
            onError(err.message || 'No se pudo generar el PDF');
        } finally {
            setGenerandoPdf(null);
        }
    };

    const pdfTodas = async () => {
        setGenerandoPdf({ n: 0, total: listas.length });
        onError(null);
        try {
            const { descargadas, fallaron } = await descargarListasPDF(listas, {
                onAvance: (n, total) => setGenerandoPdf({ n, total }),
            });
            const texto = `Descargaste ${descargadas} lista${descargadas === 1 ? '' : 's'} de proveedores en un .zip.`;
            onAviso(fallaron.length ? `${texto} No salieron: ${fallaron.join(', ')}.` : texto);
        } catch (err) {
            onError(err.message || 'No se pudieron generar las listas');
        } finally {
            setGenerandoPdf(null);
        }
    };

    const botonTodas = (
        <Button size="sm" variant="secondary" leftIcon={<Icon.Download size={13} />}
            disabled={!!generandoPdf || listas.length === 0}
            title="Baja un .zip con un PDF por proveedor: todos sus pendientes, con la cantidad que se ve en pantalla"
            onClick={pdfTodas}>
            {generandoPdf?.total ? `Generando ${generandoPdf.n} de ${generandoPdf.total}…` : `Descargar todas (${listas.length})`}
        </Button>
    );

    // La oferta del proveedor que se está mirando
    const candidatoAca = (it) => candidatosDe(it).find(c => claveNombre(c.nombre) === claveNombre(proveedor)) || null;

    const buscador = (
        <div style={{ position: 'relative', marginTop: isMobile ? 0 : 10, width: isMobile ? 200 : undefined }}>
            <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: t.color.textMuted, lineHeight: 0, pointerEvents: 'none' }}>
                <Icon.Search size={13} />
            </span>
            <input
                type="search"
                value={busqueda}
                onChange={e => setBusqueda(e.target.value)}
                placeholder="Buscar en todos los proveedores"
                aria-label="Buscar un producto en todos los proveedores"
                style={{
                    width: '100%', boxSizing: 'border-box', padding: '6px 8px 6px 28px',
                    border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm,
                    fontFamily: t.font.family, fontSize: t.font.size.sm,
                    background: t.color.surface, color: t.color.text,
                }}
            />
            {buscando && (
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginTop: 4, ...t.numericStyle }}>
                    {totalCoincidencias === 0
                        ? 'No está en la cola de ningún proveedor.'
                        : `${totalCoincidencias} producto${totalCoincidencias === 1 ? '' : 's'} en ${gruposVisibles.length} proveedor${gruposVisibles.length === 1 ? '' : 'es'}`}
                </div>
            )}
        </div>
    );


    // Al producto si hay oferta de este proveedor; si no, la web general avisando (nota 192)
    const linkDe = (it) => linkDelProducto(candidatoAca(it), acceso, proveedor);

    const borde = `1px solid ${t.color.border}`;
    const solapas = [
        ['todos', `Todos · ${delProveedor.length}`],
        ['sin', `Sin asignar · ${sinAsignar}`],
        ['vinculados', `Vinculados · ${vinculados}`],
    ];

    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '240px 1fr',
            border: borde,
            borderRadius: t.radius.lg,
            overflow: 'hidden',
            background: t.color.surface,
            minHeight: 420,
        }}>
            <div style={{
                borderRight: isMobile ? 'none' : borde,
                borderBottom: isMobile ? borde : 'none',
                background: t.color.surface2,
                display: 'flex',
                flexDirection: isMobile ? 'row' : 'column',
                overflowX: isMobile ? 'auto' : 'hidden',
                overflowY: isMobile ? 'hidden' : 'auto',
                position: isMobile ? undefined : 'sticky',
                top: 12,
                alignSelf: 'start',
                maxHeight: isMobile ? undefined : 'calc(100vh - 120px)',
            }}>
                {isMobile ? (
                    <div style={{ padding: '10px 12px', borderRight: borde, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {botonTodas}
                        {buscador}
                    </div>
                ) : (
                    <div style={{ padding: '12px 14px', borderBottom: borde }}>
                        <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>A quién se le pide</div>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginBottom: 8 }}>Más barato, el principal o el que elijas</div>
                        {botonTodas}
                        {buscador}
                    </div>
                )}
                {gruposVisibles.map(g => {
                    const activo = g.nombre === proveedor;
                    const acc = accesoDe(g.nombre, accesos);
                    const nClientes = esperas.size
                        ? items.filter(it => esperas.has(it.odoo_id) && vaA(it, g.nombre, asignaciones[it.id])).length
                        : 0;
                    return (
                        <button
                            key={g.nombre}
                            type="button"
                            onClick={() => { setProveedor(g.nombre); setSolapa('todos'); }}
                            style={{
                                display: 'block',
                                textAlign: 'left',
                                padding: '10px 14px',
                                border: 'none',
                                borderBottom: isMobile ? 'none' : borde,
                                borderRight: isMobile ? borde : 'none',
                                background: activo ? t.color.surface : 'transparent',
                                cursor: 'pointer',
                                flexShrink: 0,
                                minWidth: isMobile ? 140 : undefined,
                                fontFamily: t.font.family,
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: activo ? t.font.weight.semibold : t.font.weight.medium, color: t.color.text, fontSize: t.font.size.sm }}>{g.nombre}</span>
                                {coincidencias
                                    ? <Badge tone="primary">{coincidencias.get(g.nombre)} de {g.n}</Badge>
                                    : <Badge tone="muted">{g.n}</Badge>}
                            </div>
                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2 }}>
                                {ETIQUETA_ACCESO[acc.tipo]}{g.sin > 0 ? ` · ${g.sin} sin asignar` : ''}
                            </div>
                            {nClientes > 0 && (
                                <div style={{ fontSize: t.font.size.xs, color: t.color.accent, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4, ...t.numericStyle }}>
                                    <Icon.Users size={11} />
                                    {nClientes} para clientes
                                </div>
                            )}
                        </button>
                    );
                })}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ padding: '12px 16px', borderBottom: borde, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.lg, color: t.color.text, fontFamily: t.font.family }}>{proveedor}</span>
                    <Badge tone={acceso.tipo === 'clave' ? 'warn' : acceso.tipo === 'pdf' ? 'muted' : 'primary'}>{ETIQUETA_ACCESO[acceso.tipo]}</Badge>
                    <span style={{ marginLeft: 'auto', fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                        {acceso.tipo === 'clave' && 'Hay que ingresar. La clave no se muestra.'}
                        {acceso.tipo === 'pdf' && 'Sin ficha web: lo tildado arma el PDF.'}
                        {acceso.tipo === 'abierta' && acceso.sitio}
                    </span>
                    <Button size="sm" variant="secondary" leftIcon={<Icon.FileText size={13} />}
                        disabled={!!generandoPdf || listaAbierta.length === 0}
                        title="Baja en PDF todos los pendientes de este proveedor, con la cantidad que se ve en pantalla"
                        onClick={pdfLista}>
                        {generandoPdf === 'lista' ? 'Generando…' : 'PDF de la lista'}
                    </Button>
                    <Button size="sm" variant="ghost" title="Ver activos y archivados" disabled={!proveedor}
                        onClick={() => onVerCatalogo(proveedor)}>
                        {isMobile ? 'Catálogo' : 'Ver catálogo'}
                    </Button>
                </div>

                <div style={{ padding: '8px 16px', borderBottom: borde, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {solapas.map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setSolapa(id)}
                            style={{
                                border: borde,
                                borderRadius: t.radius.full,
                                padding: '4px 10px',
                                background: solapa === id ? t.color.surface2 : 'transparent',
                                color: t.color.text,
                                cursor: 'pointer',
                                fontSize: t.font.size.xs,
                                fontFamily: t.font.family,
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <div>
                    {visibles.length === 0 && buscando && (
                        <div style={{ padding: 16, fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                            {`Nada de ${proveedor} coincide con «${busqueda.trim()}»${solapa !== 'todos' ? ' en esta solapa' : ''}.`}
                        </div>
                    )}
                    {visibles.length === 0 && !buscando && (
                        <div style={{ padding: 16, fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                            {solapa === 'sin' && 'Este proveedor no tiene productos sin vincular.'}
                            {solapa === 'vinculados' && 'Este proveedor no tiene productos vinculados.'}
                            {solapa === 'todos' && 'Nada asignado a este proveedor.'}
                        </div>
                    )}
                    {visibles.map(it => {
                        const asignado = estaVinculado(it);
                        const barata = ofertaMasBarata(it);
                        const candidatos = candidatosDe(it);
                        const aca = candidatoAca(it);
                        // Precio del proveedor (si lo tiene) y, aparte, el costo que figura hoy en Odoo
                        const precio = aca?.precio ?? null;
                        const costoOdoo = Number(it.standard_price) > 0 ? Number(it.standard_price) : null;
                        const etiqueta = !aca || aca.es_principal
                            ? (barata ? 'principal' : 'principal, sin más barato')
                            : aca.mas_barato ? 'más económico' : 'otro proveedor';
                        // Vinculado, pero la web de este proveedor lo da sin stock
                        const noDisponible = asignado && aca && !aca.disponible;
                        const asig = asignaciones[it.id];
                        const repartido = estaRepartido(asig);
                        const enReparto = repartiendo?.id === it.id;
                        const href = asignado ? linkDe(it) : null;
                        const elegido = !!elegidos[it.id];
                        const linkChico = {
                            border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                            color: t.color.primary, fontSize: t.font.size.xs, fontFamily: t.font.family, textAlign: 'left',
                        };
                        const textoCandidato = (c) => [
                            c.nombre,
                            c.precio != null ? fmtAR(c.precio) : 'sin precio',
                            c.es_principal ? 'principal' : c.mas_barato ? 'más económico' : null,
                            c.disponible ? null : 'no disponible',
                        ].filter(Boolean).join(' · ');
                        return (
                            <div key={it.id} style={{
                                display: 'flex', alignItems: 'center', gap: 12,
                                padding: '10px 16px', borderBottom: borde,
                                background: elegido ? t.color.primarySoft : 'transparent',
                                flexWrap: isMobile ? 'wrap' : 'nowrap',
                            }}>
                                <input
                                    type="checkbox"
                                    checked={elegido}
                                    onChange={() => marcar(it.id)}
                                    aria-label={elegido ? 'Sacar del pedido' : 'Sumar al pedido'}
                                />
                                <Thumb it={it} onVerFoto={onVerFoto} size={isMobile ? 44 : 40} />
                                <div style={{ flex: 1, minWidth: 160 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <span style={{ fontWeight: t.font.weight.medium, color: t.color.text, fontSize: t.font.size.sm, fontFamily: t.font.family }}>{it.name}</span>
                                        <Badge tone={asignado ? 'success' : 'warn'}>{asignado ? 'Asignado' : 'Sin asignar'}</Badge>
                                        {noDisponible && <Badge tone="danger">No disponible</Badge>}
                                    </div>
                                    {esperas.has(it.odoo_id) && (
                                        <div
                                            title={esperas.get(it.odoo_id).map(c => `${c.name} · ${c.partner_name || 'sin cliente'} × ${fmtInt(c.qty)}`).join('\n')}
                                            style={{ marginTop: 4 }}
                                        >
                                            <Badge tone="accent" dot>{textoEspera(esperas.get(it.odoo_id))}</Badge>
                                        </div>
                                    )}
                                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginTop: 2 }}>
                                        <span style={{ fontFamily: t.font.mono }}>{it.internal_ref || it.barcode || '—'}</span>
                                        {' · '}
                                        {etiqueta}
                                        {precio != null && <span style={t.numericStyle}> · {fmtAR(precio)}</span>}
                                        {' · '}
                                        <span title="Costo que tiene cargado hoy el producto en Odoo" style={t.numericStyle}>
                                            {costoOdoo != null ? `Costo Odoo ${fmtAR(costoOdoo)}` : 'Sin costo en Odoo'}
                                        </span>
                                    </div>
                                    {repartido && !enReparto && (
                                        <div style={{ fontSize: t.font.size.xs, color: t.color.text, fontFamily: t.font.family, marginTop: 2, ...t.numericStyle }}>
                                            Repartido: {partesDe(it, asig, qtys[it.id]).map(p => `${p.destino} × ${fmtInt(p.qty)}`).join(' · ')}
                                        </div>
                                    )}
                                    {candidatos.length > 1 && !enReparto && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                                            {!repartido && (
                                                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                                                    Pedir a
                                                    <select
                                                        value={proveedor}
                                                        onChange={e => mandarA(it, e.target.value)}
                                                        aria-label={`Proveedor para ${it.name}`}
                                                        style={{
                                                            maxWidth: 280, padding: '2px 6px', border: borde, borderRadius: t.radius.sm,
                                                            background: t.color.surface, color: t.color.text,
                                                            fontFamily: t.font.family, fontSize: t.font.size.xs,
                                                        }}
                                                    >
                                                        {candidatos.map(c => (
                                                            <option key={c.nombre} value={c.nombre}>{textoCandidato(c)}</option>
                                                        ))}
                                                    </select>
                                                </label>
                                            )}
                                            <button type="button" onClick={() => abrirReparto(it)} style={linkChico}
                                                title="Pedir una parte a un proveedor y otra parte a otro">
                                                {repartido ? 'Cambiar reparto' : 'Repartir entre proveedores'}
                                            </button>
                                        </div>
                                    )}
                                    {enReparto && (
                                        <div style={{ marginTop: 6, padding: 8, border: borde, borderRadius: t.radius.sm, background: t.color.surface2 }}>
                                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginBottom: 4 }}>
                                                Cuánto le pedís a cada uno (en cero no se le pide)
                                            </div>
                                            {candidatos.map(c => (
                                                <div key={c.nombre} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                                                    <span style={{ flex: 1, minWidth: 0, fontSize: t.font.size.xs, color: c.disponible ? t.color.text : t.color.danger, fontFamily: t.font.family, ...t.numericStyle }}>
                                                        {textoCandidato(c)}
                                                    </span>
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        step={1}
                                                        value={repartiendo.cantidades[c.nombre] ?? ''}
                                                        aria-label={`Cantidad para ${c.nombre}`}
                                                        onChange={e => {
                                                            const v = e.target.value;
                                                            setRepartiendo(prev => ({ ...prev, cantidades: { ...prev.cantidades, [c.nombre]: v } }));
                                                        }}
                                                        style={{
                                                            width: 56, padding: '2px 6px', border: borde, borderRadius: t.radius.sm,
                                                            textAlign: 'right', fontFamily: t.font.family, fontSize: t.font.size.xs,
                                                            background: t.color.surface, color: t.color.text, ...t.numericStyle,
                                                        }}
                                                    />
                                                </div>
                                            ))}
                                            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                                <Button size="sm" variant="primary" onClick={() => aplicarReparto(it)}>Listo</Button>
                                                <Button size="sm" variant="ghost" onClick={() => setRepartiendo(null)}>Cancelar</Button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                {asignado && href && (
                                    <a href={href.href} target="_blank" rel="noreferrer" title={href.ayuda}
                                        style={{ fontSize: t.font.size.xs, color: href.alProducto ? t.color.primary : t.color.textMuted, fontFamily: t.font.family, whiteSpace: 'nowrap' }}>
                                        {href.texto}
                                    </a>
                                )}
                                {asignado && !href && acceso.tipo === 'pdf' && (
                                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>Entra al PDF</span>
                                )}
                                {/* Aunque ya esté asignado se pueden sumar o cambiar proveedores (nota 187) */}
                                <Button size="sm" variant={asignado ? 'ghost' : 'secondary'} leftIcon={<Icon.Link size={12} />}
                                    title={asignado ? 'Sumar otro proveedor o cambiar los vínculos' : undefined}
                                    onClick={() => onVincular(it)}>
                                    {asignado ? 'Vínculos' : 'Vincular'}
                                </Button>
                                <input
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={repartido ? (asig.find(p => p.destino === proveedor)?.qty ?? '') : (qtys[it.id] ?? '')}
                                    aria-label={repartido ? `Cantidad de ${it.name} para ${proveedor}` : `Cantidad de ${it.name}`}
                                    title={repartido ? `Lo que se le pide a ${proveedor}. Total: ${fmtInt(totalDe(it))}` : undefined}
                                    onChange={e => cambiarQty(it, e.target.value)}
                                    onBlur={() => salirDeQty(it)}
                                    style={{
                                        width: 64, padding: '4px 6px', border: borde, borderRadius: t.radius.sm,
                                        textAlign: 'right', fontFamily: t.font.family, fontSize: t.font.size.sm,
                                        background: t.color.surface, color: t.color.text,
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => quitar([it])}
                                    disabled={quitando != null}
                                    aria-label={`Quitar ${it.name} de reposición`}
                                    title="Quitar de reposición (queda en Resueltos como descartado)"
                                    style={{
                                        border: 'none', background: 'none', padding: 4, lineHeight: 0, flexShrink: 0,
                                        color: t.color.textMuted, cursor: quitando != null ? 'default' : 'pointer',
                                        borderRadius: t.radius.sm, opacity: quitando === it.id ? 0.4 : 1,
                                    }}
                                >
                                    <Icon.X size={16} />
                                </button>
                            </div>
                        );
                    })}
                </div>

                <div style={{ padding: '12px 16px', borderTop: borde, background: t.color.surface2, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                        <div style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                            Pedido de {proveedor}
                            {tildados.length > 0 && ` · ${tildados.length}`}
                        </div>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                            {tildados.length === 0
                                ? 'Todavía no tildaste nada de este proveedor.'
                                : tildados.map(it => `${qtyAca(it) || 0} × ${it.name}`).join(' · ')}
                        </div>
                    </div>
                    {tildados.length > 0 && (
                        <Button size="sm" variant="ghost" leftIcon={<Icon.X size={13} />} disabled={quitando != null || trabajando}
                            title="Saca de reposición lo tildado (queda en Resueltos como descartado)"
                            onClick={() => quitar(tildados)}>
                            {quitando === 'tildados' ? 'Quitando…' : `Quitar tildados (${tildados.length})`}
                        </Button>
                    )}
                    <Button size="sm" variant="secondary" leftIcon={<Icon.FileText size={13} />} disabled={!!generandoPdf} onClick={pdf}
                        title="Baja en PDF solo lo que tildaste">
                        {generandoPdf === 'tildados' ? 'Generando…' : 'PDF'}
                    </Button>
                    <Button size="sm" variant="primary" leftIcon={<Icon.ShoppingCart size={13} />} disabled={trabajando} onClick={pasarAEncargados}>
                        {trabajando ? 'Pasando…' : 'Pasar a encargados'}
                    </Button>
                </div>

                {deCotizaciones.length > 0 && onReponerCotiz && (
                    <div style={{ borderTop: borde, padding: '12px 16px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: 180 }}>
                                <div style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                                    De cotizaciones pendientes · {deCotizaciones.length}
                                </div>
                                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginTop: 2 }}>
                                    Clientes esperando mercadería de {proveedor} que todavía no está en la cola. Entra con la cantidad que pidieron.
                                </div>
                            </div>
                            <Button size="sm" variant="secondary" leftIcon={<Icon.Plus size={13} />} disabled={reponiendoCotiz}
                                onClick={() => onReponerCotiz({ proveedor })}>
                                {reponiendoCotiz ? 'Sumando…' : `Sumar todos (${deCotizaciones.length})`}
                            </Button>
                        </div>
                        <div style={{ marginTop: 8 }}>
                            {deCotizaciones.map(p => (
                                <div key={p.odoo_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: borde }}>
                                    <Thumb it={p} onVerFoto={onVerFoto} size={36} />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family }}>{p.name}</div>
                                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                                            <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || '—'}</span>
                                            {' · '}
                                            {p.cotizaciones.filter(c => !c.llego && !c.separado).map(c => `${c.name}${c.partner_name ? ` (${clienteCorto(c.partner_name)})` : ''} × ${fmtInt(c.qty - (c.qty_llegada || 0))}`).join(' · ')}
                                        </div>
                                    </div>
                                    <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family, ...t.numericStyle }}>
                                        × {fmtInt(p.qty_falta ?? p.qty_total)}
                                    </span>
                                    <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={13} />} disabled={reponiendoCotiz}
                                        onClick={() => onReponerCotiz({ odoo_ids: [p.odoo_id] })}>
                                        Reponer
                                    </Button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
