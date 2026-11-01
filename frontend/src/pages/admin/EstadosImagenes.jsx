import { useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Card from '../../components/common/Card';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import * as Icon from '../../components/common/icons';
import { odooImageUrl } from './whatsappUtils';
import { buildZip } from './zipStore';
import {
    FORMATOS, LOGO_URL, cargarImagen, prepararFuentes, dibujarEstado,
    canvasABlob, nombreArchivo, guardarArchivo,
} from './estadoImagen';

const fotoUrl = (company, templateId) => `${odooImageUrl(company, templateId)}?size=1024`;

// Arma la imagen de un producto en un canvas nuevo (o en el que se pase).
async function armar(product, company, formato, canvas = document.createElement('canvas')) {
    await prepararFuentes();
    const [logo, foto] = await Promise.all([
        cargarImagen(LOGO_URL).catch(() => null),
        cargarImagen(fotoUrl(company, product.template_id)),
    ]);
    return dibujarEstado(canvas, { formato, logo, foto, nombre: product.name, precio: product.price_label });
}

function hoy() {
    return new Date().toISOString().slice(0, 10);
}

function EstadoPreview({ product, company, formato }) {
    const { tokens: t } = useTheme();
    const ref = useRef(null);
    const [fallo, setFallo] = useState(false);
    const f = FORMATOS[formato];

    useEffect(() => {
        let vivo = true;
        setFallo(false);
        armar(product, company, formato, ref.current).catch(() => { if (vivo) setFallo(true); });
        return () => { vivo = false; };
    }, [product, company, formato]);

    return (
        <div style={{ position: 'relative', width: '100%', aspectRatio: `${f.w} / ${f.h}`, border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, overflow: 'hidden', background: t.color.surface2 }}>
            <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
            {fallo && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.color.danger, fontSize: t.font.size.sm, padding: t.space[4], textAlign: 'center' }}>
                    No se pudo cargar la foto
                </div>
            )}
        </div>
    );
}

// Sorteo de productos por categoría → imágenes para subir a mano a los estados.
export default function EstadosImagenes() {
    const { tokens: t } = useTheme();
    const [company, setCompany] = useState('preventas');
    const [formato, setFormato] = useState('historia');
    const [categories, setCategories] = useState([]);
    const [selected, setSelected] = useState([]);
    const [count, setCount] = useState('10');
    const [picks, setPicks] = useState([]);
    const [descargadas, setDescargadas] = useState(() => new Set());
    const [busy, setBusy] = useState('');
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [toArchive, setToArchive] = useState(null);

    useEffect(() => {
        api.get('/estados-imagenes/categorias', { company }).then((res) => {
            if (res.success) setCategories(res.data || []);
            else setError(res.error);
        });
        setSelected([]);
        setPicks([]);
        setDescargadas(new Set());
    }, [company]);

    const shownIds = (except = null) => picks
        .filter((c) => c.category !== except)
        .flatMap((c) => c.products.map((p) => p.odoo_id));

    function toggle(cat) {
        setSelected((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
    }

    async function sortear() {
        setBusy('sortear'); setError(null); setNotice(null);
        const res = await api.post('/estados-imagenes/sorteo', { company, categories: selected, count: Number(count) });
        setBusy('');
        if (!res.success) { setError(res.error); return; }
        setPicks(res.data);
        setDescargadas(new Set());
        const short = res.data.filter((c) => c.products.length < Number(count));
        if (short.length) {
            setNotice(`No alcanzaron los productos nuevos en: ${short.map((c) => `${c.category} (${c.products.length})`).join(', ')}. Lo descargado o publicado en los últimos 7 días no se repite.`);
        }
    }

    async function reshuffle(category) {
        setBusy(`cat:${category}`); setError(null);
        const res = await api.post('/estados-imagenes/sorteo', {
            company, categories: [category], count: Number(count), exclude_ids: shownIds(category),
        });
        setBusy('');
        if (!res.success) { setError(res.error); return; }
        setPicks((prev) => prev.map((c) => (c.category === category ? res.data[0] : c)));
    }

    // Saca un producto y pone otro de la misma categoría en su lugar.
    async function replace(category, odooId) {
        const res = await api.post('/estados-imagenes/sorteo', {
            company, categories: [category], count: 1, exclude_ids: [...shownIds(), odooId],
        });
        const fresh = res.success ? res.data[0]?.products[0] : null;
        setPicks((prev) => prev.map((c) => {
            if (c.category !== category) return c;
            const products = fresh
                ? c.products.map((p) => (p.odoo_id === odooId ? fresh : p))
                : c.products.filter((p) => p.odoo_id !== odooId);
            return { ...c, products };
        }));
        if (!res.success) setError(res.error);
    }

    async function swap(category, product) {
        setBusy(`p:${product.odoo_id}`);
        await replace(category, product.odoo_id);
        setBusy('');
    }

    async function reponer(product) {
        setBusy(`p:${product.odoo_id}`); setError(null);
        const res = await api.post('/reposicion', { odoo_id: product.odoo_id });
        setBusy('');
        if (!res.success) { setError(res.error || 'No se pudo marcar para reponer'); return; }
        const como = res.data?.origen === 'archivado' ? 'agotado' : 'queda poco';
        setNotice(`«${product.name}» entró a Reposición como «${como}».`);
    }

    async function archive() {
        const { category, product } = toArchive;
        setToArchive(null);
        setBusy(`p:${product.odoo_id}`); setError(null);
        const res = await api.patch(`/products/odoo/${product.odoo_id}/archive`, { company, archived: true });
        if (!res.success) { setBusy(''); setError(res.error); return; }
        await replace(category, product.odoo_id);
        setBusy('');
        setNotice(company === 'neggo' && res.data?.en_cola
            ? `«${product.name}» se archivó en Odoo y fue a Reposición como agotado.`
            : `«${product.name}» archivado en Odoo.`);
    }

    // Anota lo bajado para que no vuelva a salir en el sorteo.
    async function anotar(ids) {
        const res = await api.post('/estados-imagenes/descargas', { company, odoo_ids: ids, formato });
        if (!res.success) { setError(`Se descargó, pero no pude anotarlo: ${res.error}`); return; }
        setDescargadas((prev) => new Set([...prev, ...ids]));
    }

    async function descargarUna(product) {
        setBusy(`p:${product.odoo_id}`); setError(null);
        try {
            const blob = await canvasABlob(await armar(product, company, formato));
            guardarArchivo(blob, `${nombreArchivo(product.name)}-${formato}.png`);
            await anotar([product.odoo_id]);
        } catch (err) {
            setError(`«${product.name}»: ${err.message}`);
        }
        setBusy('');
    }

    async function descargarTodas() {
        setBusy('zip'); setError(null); setNotice(null);
        const files = [];
        const ids = [];
        const fallaron = [];
        for (const c of picks) {
            for (const [i, p] of c.products.entries()) {
                try {
                    const blob = await canvasABlob(await armar(p, company, formato));
                    const data = new Uint8Array(await blob.arrayBuffer());
                    files.push({ name: `${nombreArchivo(c.category, 40)}/${String(i + 1).padStart(2, '0')}-${nombreArchivo(p.name)}.png`, data });
                    ids.push(p.odoo_id);
                } catch {
                    fallaron.push(p.name);
                }
            }
        }
        if (files.length) {
            const zip = buildZip(files);
            guardarArchivo(new Blob([zip], { type: 'application/zip' }), `estados-${company}-${formato}-${hoy()}.zip`);
            await anotar(ids);
            setNotice(`Descargaste ${files.length} imagen${files.length === 1 ? '' : 'es'} en un .zip.${fallaron.length ? ` No salieron (sin foto): ${fallaron.join(', ')}.` : ''}`);
        } else {
            setError('No se pudo armar ninguna imagen.');
        }
        setBusy('');
    }

    const label = { fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginBottom: 6 };
    const sectionTitle = { fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, margin: 0 };
    const total = picks.reduce((acc, c) => acc + c.products.length, 0);
    const minCard = formato === 'historia' ? 190 : 230;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
            {error && <Card style={{ background: t.color.dangerSoft, color: t.color.danger }}>{error}</Card>}
            {notice && <Card style={{ background: t.color.successSoft, color: t.color.success }}>{notice}</Card>}

            <Card>
                <h2 style={sectionTitle}>Imágenes para estados</h2>
                <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm, marginTop: 6 }}>
                    Elegí categorías y se sortean productos de Odoo con foto y precio de venta del catálogo. Revisá cómo queda cada imagen, descargalas y subilas a mano a los estados. No se repite lo descargado, lo que está en cola ni lo publicado en los últimos 7 días.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: t.space[3], marginTop: t.space[4] }}>
                    <div>
                        <div style={label}>Lista</div>
                        <Select value={company} onChange={setCompany} options={[
                            { value: 'preventas', label: 'Preventas' },
                            { value: 'neggo', label: 'Neggo' },
                        ]} />
                    </div>
                    <div>
                        <div style={label}>Formato</div>
                        <Select value={formato} onChange={setFormato} options={Object.entries(FORMATOS).map(([value, f]) => ({ value, label: f.label }))} />
                    </div>
                    <div>
                        <div style={label}>Fotos por categoría</div>
                        <Input type="number" min="1" max="50" value={count} onChange={(e) => setCount(e.target.value)} />
                    </div>
                </div>
                <div style={{ ...label, marginTop: t.space[4] }}>Categorías</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2] }}>
                    {categories.map(({ name: cat, count: available }) => {
                        const on = selected.includes(cat);
                        return (
                            <button
                                key={cat}
                                type="button"
                                onClick={() => toggle(cat)}
                                style={{
                                    padding: '6px 12px',
                                    borderRadius: t.radius.full,
                                    border: `1px solid ${on ? t.color.primary : t.color.borderStrong}`,
                                    background: on ? t.color.primarySoft : t.color.surface,
                                    color: on ? t.color.primary : t.color.text,
                                    fontFamily: t.font.family,
                                    fontSize: t.font.size.sm,
                                    fontWeight: on ? t.font.weight.semibold : t.font.weight.regular,
                                    cursor: 'pointer',
                                }}
                            >
                                {cat} <span style={{ color: t.color.textMuted, ...t.numericStyle }}>{available}</span>
                            </button>
                        );
                    })}
                </div>
                <div style={{ display: 'flex', gap: t.space[3], marginTop: t.space[4], flexWrap: 'wrap' }}>
                    <Button variant="primary" leftIcon={<Icon.Refresh size={16} />} onClick={sortear} disabled={busy === 'sortear' || !selected.length}>
                        {busy === 'sortear' ? 'Sorteando…' : 'Generar imágenes'}
                    </Button>
                    {total > 0 && (
                        <Button variant="success" leftIcon={<Icon.Download size={16} />} onClick={descargarTodas} disabled={!!busy}>
                            {busy === 'zip' ? 'Armando el .zip…' : `Descargar todas (${total})`}
                        </Button>
                    )}
                </div>
            </Card>

            {picks.map((c) => (
                <Card key={c.category}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: t.font.size.base }}>
                            {c.category} <span style={{ color: t.color.textMuted, fontWeight: t.font.weight.regular, ...t.numericStyle }}>· {c.products.length}</span>
                        </strong>
                        <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={14} />} onClick={() => reshuffle(c.category)} disabled={busy === `cat:${c.category}`}>
                            Sortear de nuevo
                        </Button>
                    </div>
                    {c.products.length === 0 && (
                        <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm }}>No quedan productos nuevos en esta categoría.</p>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${minCard}px, 1fr))`, gap: t.space[4], marginTop: t.space[3] }}>
                        {c.products.map((p) => {
                            const working = busy === `p:${p.odoo_id}`;
                            const bajada = descargadas.has(p.odoo_id);
                            return (
                                <div key={p.odoo_id} style={{
                                    border: `1px solid ${t.color.border}`,
                                    borderRadius: t.radius.md,
                                    padding: t.space[3],
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: t.space[2],
                                    opacity: working ? 0.5 : 1,
                                    background: t.color.surface,
                                }}>
                                    <EstadoPreview product={p} company={company} formato={formato} />
                                    <div style={{ fontSize: t.font.size.xs, color: t.color.text, lineHeight: 1.3 }}>{p.name}</div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[2] }}>
                                        <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>{p.odoo_id}</span>
                                        {bajada && (
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: t.font.size.xs, color: t.color.success }}>
                                                <Icon.Check size={14} /> Descargada
                                            </span>
                                        )}
                                    </div>
                                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                        <Button size="sm" variant="primary" leftIcon={<Icon.Download size={14} />} onClick={() => descargarUna(p)} disabled={working || busy === 'zip'}>
                                            Descargar
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => swap(c.category, p)} disabled={working} title="Cambiar por otro al azar">
                                            Cambiar
                                        </Button>
                                        {company === 'neggo' && (
                                            <Button size="sm" variant="ghost" onClick={() => reponer(p)} disabled={working} title="Queda poco: entra a la cola de Reposición">
                                                Reponer
                                            </Button>
                                        )}
                                        <Button size="sm" variant="danger" onClick={() => setToArchive({ category: c.category, product: p })} disabled={working}>
                                            Archivar
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </Card>
            ))}

            <ConfirmDialog
                isOpen={!!toArchive}
                onClose={() => setToArchive(null)}
                onConfirm={archive}
                danger
                title="Archivar en Odoo"
                confirmLabel="Archivar"
                message={toArchive
                    ? (company === 'neggo'
                        ? `«${toArchive.product.name}» se archiva en Odoo (no queda stock) y entra a Reposición como agotado. Se reemplaza por otro de la misma categoría.`
                        : `«${toArchive.product.name}» se archiva en Odoo Preventas: deja de estar a la venta y no vuelve a salir en los sorteos. Se reemplaza por otro de la misma categoría.`)
                    : ''}
            />
        </div>
    );
}
