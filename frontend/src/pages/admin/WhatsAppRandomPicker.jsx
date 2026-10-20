import { useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Card from '../../components/common/Card';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';
import { defaultSchedule, odooImageUrl } from './whatsappUtils';

// Sorteo de N fotos por categoría: se revisan, se cambian o archivan, y se programan.
export default function WhatsAppRandomPicker({ groupJid, groupSubject, intervalSeconds, onScheduled, onError, onNotice }) {
    const { tokens: t } = useTheme();
    const [company, setCompany] = useState('preventas');
    const [categories, setCategories] = useState([]);
    const [selected, setSelected] = useState([]);
    const [count, setCount] = useState('20');
    const [scheduledAt, setScheduledAt] = useState(defaultSchedule);
    const [picks, setPicks] = useState([]);
    const [busy, setBusy] = useState('');
    const [toArchive, setToArchive] = useState(null);

    useEffect(() => {
        api.get('/whatsapp/random-categories', { company }).then((res) => {
            if (res.success) setCategories(res.data || []);
        });
        setSelected([]);
        setPicks([]);
    }, [company]);

    const shownIds = (except = null) => picks
        .filter((c) => c.category !== except)
        .flatMap((c) => c.products.map((p) => p.odoo_id));

    function toggle(cat) {
        setSelected((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
    }

    async function generate() {
        setBusy('generate'); onError(null);
        const res = await api.post('/whatsapp/random-pick', { company, categories: selected, count: Number(count) });
        setBusy('');
        if (!res.success) { onError(res.error); return; }
        setPicks(res.data);
        const short = res.data.filter((c) => c.products.length < Number(count));
        if (short.length) {
            onNotice(`No alcanzaron los productos nuevos en: ${short.map((c) => `${c.category} (${c.products.length})`).join(', ')}. Lo publicado en los últimos 7 días no se repite.`);
        }
    }

    async function reshuffle(category) {
        setBusy(`cat:${category}`); onError(null);
        const res = await api.post('/whatsapp/random-pick', {
            company, categories: [category], count: Number(count), exclude_ids: shownIds(category),
        });
        setBusy('');
        if (!res.success) { onError(res.error); return; }
        setPicks((prev) => prev.map((c) => (c.category === category ? res.data[0] : c)));
    }

    // Saca un producto de la lista y pone otro de la misma categoría en su lugar.
    async function replace(category, odooId) {
        const res = await api.post('/whatsapp/random-pick', {
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
        if (!res.success) onError(res.error);
    }

    async function swap(category, product) {
        setBusy(`p:${product.odoo_id}`);
        await replace(category, product.odoo_id);
        setBusy('');
    }

    async function archive() {
        const { category, product } = toArchive;
        setToArchive(null);
        setBusy(`p:${product.odoo_id}`); onError(null);
        const res = await api.patch(`/products/odoo/${product.odoo_id}/archive`, { company, archived: true });
        if (!res.success) { setBusy(''); onError(res.error); return; }
        await replace(category, product.odoo_id);
        setBusy('');
        onNotice(`"${product.name}" archivado en Odoo.`);
    }

    async function sendNow(category, product) {
        setBusy(`p:${product.odoo_id}`); onError(null);
        const res = await api.post('/whatsapp/send-now', { company, odoo_id: product.odoo_id, group_jid: groupJid || undefined });
        if (!res.success) { setBusy(''); onError(res.error); return; }
        await replace(category, product.odoo_id);
        setBusy('');
        onNotice(`"${product.name}" sale ahora. Lo ves en la cola.`);
        onScheduled();
    }

    async function schedule() {
        setBusy('schedule'); onError(null);
        const res = await api.post('/whatsapp/batches/random', {
            company,
            scheduled_at: scheduledAt,
            interval_seconds: Number(intervalSeconds),
            group_jid: groupJid || undefined,
            group_subject: groupSubject || undefined,
            groups: picks.map((c) => ({ category: c.category, odoo_ids: c.products.map((p) => p.odoo_id) })),
        });
        setBusy('');
        if (!res.success) { onError(res.error); return; }
        const total = res.data.reduce((acc, b) => acc + b.total, 0);
        onNotice(`Programaste ${res.data.length} tanda${res.data.length === 1 ? '' : 's'} con ${total} fotos.`);
        setPicks([]);
        onScheduled();
    }

    const label = { fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginBottom: 6 };
    const sectionTitle = { fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, margin: 0 };
    const total = picks.reduce((acc, c) => acc + c.products.length, 0);

    return (
        <Card>
            <h2 style={sectionTitle}>Generar imágenes</h2>
            <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm, marginTop: 6 }}>
                Elegí categorías y se sortean fotos de productos de Odoo con su precio de venta (el mismo del catálogo PDF). No se repite lo que ya está en cola ni lo publicado en los últimos 7 días. Si elegís varias categorías, se publican una atrás de la otra.
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
                    <div style={label}>Fotos por categoría</div>
                    <Input type="number" min="1" max="50" value={count} onChange={(e) => setCount(e.target.value)} />
                </div>
                <div>
                    <div style={label}>Empieza (hora de Argentina)</div>
                    <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
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
                <Button variant="primary" leftIcon={<Icon.Refresh size={16} />} onClick={generate} disabled={busy === 'generate' || !selected.length}>
                    {busy === 'generate' ? 'Sorteando…' : 'Generar imágenes'}
                </Button>
                {total > 0 && (
                    <Button variant="success" leftIcon={<Icon.MessageCircle size={16} />} onClick={schedule} disabled={busy === 'schedule'}>
                        Programar {total} fotos
                    </Button>
                )}
            </div>

            {picks.map((c) => (
                <div key={c.category} style={{ marginTop: t.space[8] }}>
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
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: t.space[4], marginTop: t.space[3] }}>
                        {c.products.map((p) => {
                            const working = busy === `p:${p.odoo_id}`;
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
                                    <ProductThumb imageUrl={odooImageUrl(company, p.template_id)} emoji={p.name?.[0]} size={146} style={{ alignSelf: 'center' }} />
                                    <div style={{ fontSize: t.font.size.sm, color: t.color.text, lineHeight: 1.3, minHeight: 34 }}>{p.name}</div>
                                    <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>{p.odoo_id}</div>
                                    <div style={{ fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text, ...t.numericStyle }}>{p.price_label}</div>
                                    {p.url ? (
                                        <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: t.font.size.xs, color: t.color.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.url}>
                                            Ver en la web
                                        </a>
                                    ) : (
                                        <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>Sin link en la web</span>
                                    )}
                                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                        <Button size="sm" variant="ghost" onClick={() => sendNow(c.category, p)} disabled={working} title="Mandar esta foto ahora">
                                            Enviar ya
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => swap(c.category, p)} disabled={working} title="Cambiar por otro al azar">
                                            Cambiar
                                        </Button>
                                        <Button size="sm" variant="danger" onClick={() => setToArchive({ category: c.category, product: p })} disabled={working}>
                                            Archivar
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}

            <ConfirmDialog
                isOpen={!!toArchive}
                onClose={() => setToArchive(null)}
                onConfirm={archive}
                danger
                title="Archivar en Odoo"
                confirmLabel="Archivar"
                message={toArchive ? `"${toArchive.product.name}" se archiva en Odoo: deja de estar a la venta y no vuelve a salir en los sorteos. Se reemplaza por otro de la misma categoría.` : ''}
            />
        </Card>
    );
}
