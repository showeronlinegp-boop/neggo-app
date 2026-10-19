import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import ProductThumb from '../../components/common/ProductThumb';
import { fmtWhen, fmtCountdown, odooImageUrl } from './whatsappUtils';

const VISIBLE = 60;

// Lo que falta publicar, en orden, con cuenta regresiva por foto.
export default function WhatsAppQueue({ refreshKey }) {
    const { tokens: t } = useTheme();
    const [messages, setMessages] = useState([]);
    const [skew, setSkew] = useState(0);
    const [now, setNow] = useState(Date.now());

    const load = useCallback(async () => {
        const res = await api.get('/whatsapp/queue');
        if (!res.success) return;
        // Corrige la diferencia entre el reloj de la PC y el del servidor.
        setSkew(new Date(res.data.now).getTime() - Date.now());
        setMessages(res.data.messages || []);
    }, []);

    useEffect(() => { load(); }, [load, refreshKey]);

    useEffect(() => {
        const id = setInterval(load, 5000);
        return () => clearInterval(id);
    }, [load]);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);

    const serverNow = now + skew;
    const next = messages.find((m) => m.batch_status !== 'pausada');

    function countdown(m) {
        if (m.batch_status === 'pausada') return <Badge tone="warn">Pausada</Badge>;
        if (m.status === 'enviando') return <Badge tone="primary">Enviando…</Badge>;
        const ms = new Date(m.scheduled_at).getTime() - serverNow;
        if (ms <= 0) return <Badge tone="primary">En instantes</Badge>;
        return <span style={{ ...t.numericStyle, fontWeight: t.font.weight.semibold }}>{fmtCountdown(ms)}</span>;
    }

    const sectionTitle = { fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, margin: 0 };
    const th = { textAlign: 'left', padding: '8px 14px', color: t.color.textMuted, fontWeight: t.font.weight.semibold, borderBottom: `1px solid ${t.color.border}` };
    const td = { padding: '8px 14px', verticalAlign: 'middle' };

    return (
        <Card padding={false}>
            <div style={{ padding: t.space[5], paddingBottom: t.space[3], display: 'flex', justifyContent: 'space-between', gap: t.space[3], flexWrap: 'wrap', alignItems: 'baseline' }}>
                <h2 style={sectionTitle}>
                    En cola <span style={{ color: t.color.textMuted, fontWeight: t.font.weight.regular, ...t.numericStyle }}>· {messages.length}</span>
                </h2>
                {next && (
                    <span style={{ color: t.color.textMuted, fontSize: t.font.size.sm }}>
                        Próxima foto: {countdown(next)}
                    </span>
                )}
            </div>
            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: t.font.family, fontSize: t.font.size.sm }}>
                    <thead>
                        <tr>
                            {['Producto', 'Precio', 'Categoría', 'Grupo', 'Sale', 'Falta'].map((h) => <th key={h} style={th}>{h}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {messages.length === 0 && (
                            <tr><td colSpan={6} style={{ padding: 16, color: t.color.textMuted }}>No hay nada en cola.</td></tr>
                        )}
                        {messages.slice(0, VISIBLE).map((m) => (
                            <tr key={m.id} style={{ borderBottom: `1px solid ${t.color.border}` }}>
                                <td style={td}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3] }}>
                                        <ProductThumb imageUrl={odooImageUrl(m.company, m.image_template_id)} emoji={m.product_name?.[0]} size={36} />
                                        <div>
                                            <div>{m.product_name}</div>
                                            <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>
                                                {m.odoo_id} · tanda #{m.batch_id}{m.attempts ? ` · intento ${m.attempts}` : ''}
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td style={{ ...td, ...t.numericStyle, whiteSpace: 'nowrap' }}>{m.price_label}</td>
                                <td style={td}>{m.category || '—'}</td>
                                <td style={td}>{m.group_name}</td>
                                <td style={{ ...td, ...t.numericStyle, whiteSpace: 'nowrap' }}>{fmtWhen(m.scheduled_at)}</td>
                                <td style={{ ...td, whiteSpace: 'nowrap' }}>{countdown(m)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {messages.length > VISIBLE && (
                <p style={{ padding: `0 ${t.space[5]}px ${t.space[5]}px`, color: t.color.textMuted, fontSize: t.font.size.sm }}>
                    Y {messages.length - VISIBLE} más.
                </p>
            )}
        </Card>
    );
}
