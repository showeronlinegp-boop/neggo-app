import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import * as Icon from '../../components/common/icons';

function defaultSchedule() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtWhen(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

const STATUS_TONE = {
    programada: 'muted',
    en_curso: 'primary',
    pausada: 'warn',
    cancelada: 'danger',
    completada: 'success',
    pendiente: 'muted',
    enviando: 'primary',
    enviado: 'success',
    error: 'danger',
};

export default function WhatsAppPublish() {
    const { tokens: t } = useTheme();
    const { user } = useAuth();
    const [status, setStatus] = useState(null);
    const [qr, setQr] = useState(null);
    const [qrStatus, setQrStatus] = useState(null);
    const [groups, setGroups] = useState([]);
    const [groupJid, setGroupJid] = useState('');
    const [intervalSeconds, setIntervalSeconds] = useState('90');
    const [company, setCompany] = useState('preventas');
    const [filters, setFilters] = useState({ categories: [], dest_categories: [], pricelists: [] });
    const [category, setCategory] = useState('');
    const [destCategory, setDestCategory] = useState('');
    const [pricelistId, setPricelistId] = useState('');
    const [destino, setDestino] = useState('grupo');
    const [scheduledAt, setScheduledAt] = useState(defaultSchedule);
    const [preview, setPreview] = useState(null);
    const [batches, setBatches] = useState([]);
    const [openId, setOpenId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    const loadStatus = useCallback(async () => {
        const res = await api.get('/whatsapp/status');
        if (!res.success) { setError(res.error); return; }
        setStatus(res.data);
        if (res.data.settings?.group_jid) setGroupJid(res.data.settings.group_jid);
        if (res.data.settings?.interval_seconds) setIntervalSeconds(String(res.data.settings.interval_seconds));
    }, []);

    const loadBatches = useCallback(async () => {
        const res = await api.get('/whatsapp/batches');
        if (res.success) setBatches(res.data || []);
    }, []);

    useEffect(() => { loadStatus(); loadBatches(); }, [loadStatus, loadBatches]);

    useEffect(() => {
        const id = setInterval(loadBatches, 5000);
        return () => clearInterval(id);
    }, [loadBatches]);

    useEffect(() => {
        api.get('/whatsapp/filters', { company }).then((res) => {
            if (res.success) setFilters(res.data);
        });
        setCategory('');
        setDestCategory('');
        setPreview(null);
    }, [company]);

    useEffect(() => {
        if (!openId) { setDetail(null); return; }
        let stop = false;
        const pull = () => api.get(`/whatsapp/batches/${openId}`).then((res) => {
            if (!stop && res.success) setDetail(res.data);
        });
        pull();
        const id = setInterval(pull, 5000);
        return () => { stop = true; clearInterval(id); };
    }, [openId]);

    if (user && user.role !== 'admin') {
        return <p style={{ color: t.color.textMuted }}>Solo un administrador puede publicar en WhatsApp.</p>;
    }

    const evo = status?.evolution;
    const evoStatus = status?.evolution_status;
    const connected = evo?.state === 'open';
    const statusConnected = evoStatus?.state === 'open';

    async function connect(which) {
        const key = which === 'estado' ? 'qr-estado' : 'qr';
        setBusy(key); setError(null);
        const res = await api.post('/whatsapp/connect', { destino: which });
        setBusy('');
        if (!res.success) { setError(res.error); return; }
        if (which === 'estado') setQrStatus(res.data);
        else setQr(res.data);
        loadStatus();
    }

    async function loadGroups() {
        setBusy('groups'); setError(null);
        const res = await api.get('/whatsapp/groups');
        setBusy('');
        if (!res.success) { setError(res.error); return; }
        setGroups(res.data || []);
        if (!res.data?.length) setNotice('La instancia no devolvió grupos. El número tiene que estar conectado y ser miembro del grupo.');
    }

    async function saveSettings() {
        setBusy('save'); setError(null); setNotice(null);
        const subject = groups.find((g) => g.jid === groupJid)?.subject;
        const res = await api.put('/whatsapp/settings', {
            group_jid: groupJid,
            group_subject: subject,
            interval_seconds: Number(intervalSeconds),
        });
        setBusy('');
        if (!res.success) { setError(res.error); return; }
        setNotice(`Grupo guardado${subject ? `: ${subject}` : ''}.`);
        loadStatus();
    }

    async function runPreview() {
        setBusy('preview'); setError(null); setPreview(null);
        const res = await api.post('/whatsapp/preview', {
            company,
            category: category || null,
            dest_category: destCategory || null,
            pricelist_id: pricelistId ? Number(pricelistId) : null,
        });
        setBusy('');
        if (!res.success) { setError(res.error); return; }
        setPreview(res.data);
    }

    async function schedule() {
        setBusy('schedule'); setError(null); setNotice(null);
        const res = await api.post('/whatsapp/batches', {
            company,
            category: category || null,
            dest_category: destCategory || null,
            pricelist_id: pricelistId ? Number(pricelistId) : null,
            scheduled_at: scheduledAt,
            interval_seconds: Number(intervalSeconds),
            destino,
            group_jid: destino === 'estado' ? undefined : (groupJid || undefined),
        });
        setBusy('');
        if (!res.success) { setError(res.error); return; }
        const donde = destino === 'estado' ? 'en los estados' : 'en el grupo';
        setNotice(`Tanda #${res.data.id} programada ${donde} con ${res.data.total} productos.`);
        setOpenId(res.data.id);
        loadBatches();
    }

    async function act(id, name) {
        setError(null);
        const res = await api.post(`/whatsapp/batches/${id}/${name}`);
        if (!res.success) { setError(res.error); return; }
        if (openId === id) setDetail(res.data);
        loadBatches();
    }

    const label = { fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginBottom: 6 };
    const sectionTitle = { fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, margin: 0 };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
            {error && (
                <Card style={{ background: t.color.dangerSoft, color: t.color.danger }}>{error}</Card>
            )}
            {notice && (
                <Card style={{ background: t.color.successSoft, color: t.color.success }}>{notice}</Card>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: t.space[5] }}>
                <Card>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[3], flexWrap: 'wrap' }}>
                        <div>
                            <h2 style={sectionTitle}>Instancia de grupos</h2>
                            <p style={{ color: t.color.textMuted, margin: '6px 0 0', fontSize: t.font.size.sm }}>
                                {evo?.instance || 'neggo'}
                                {evo?.error ? ` — ${evo.error}` : ''}
                            </p>
                        </div>
                        <Badge tone={connected ? 'success' : 'warn'} dot>
                            {connected ? 'Conectado' : (evo?.state || 'Sin conexión')}
                        </Badge>
                    </div>
                    <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm }}>
                        Este número publica en el grupo. En el teléfono: WhatsApp → Dispositivos vinculados → Vincular dispositivo.
                    </p>
                    <Button variant="primary" onClick={() => connect('grupo')} disabled={busy === 'qr'}>
                        {busy === 'qr' ? 'Generando…' : 'Mostrar QR'}
                    </Button>
                    {qr?.base64 && !qr.connected && (
                        <img
                            alt="Código QR de la instancia de grupos"
                            src={qr.base64.startsWith('data:') ? qr.base64 : `data:image/png;base64,${qr.base64}`}
                            style={{ width: 220, height: 220, marginTop: t.space[4], background: '#fff', borderRadius: t.radius.md }}
                        />
                    )}
                    {qr?.connected && <p style={{ color: t.color.success }}>El número de grupos ya está vinculado.</p>}
                </Card>
                <Card>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[3], flexWrap: 'wrap' }}>
                        <div>
                            <h2 style={sectionTitle}>Instancia de estados</h2>
                            <p style={{ color: t.color.textMuted, margin: '6px 0 0', fontSize: t.font.size.sm }}>
                                {evoStatus?.instance || 'neggo-estados'}
                                {evoStatus?.error ? ` — ${evoStatus.error}` : ''}
                            </p>
                        </div>
                        <Badge tone={statusConnected ? 'success' : 'warn'} dot>
                            {statusConnected ? 'Conectado' : (evoStatus?.state || 'Sin conexión')}
                        </Badge>
                    </div>
                    <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm }}>
                        Otro número. Los estados salen solo por esta instancia, no por la de los grupos.
                    </p>
                    <Button variant="primary" onClick={() => connect('estado')} disabled={busy === 'qr-estado'}>
                        {busy === 'qr-estado' ? 'Generando…' : 'Mostrar QR'}
                    </Button>
                    {qrStatus?.base64 && !qrStatus.connected && (
                        <img
                            alt="Código QR de la instancia de estados"
                            src={qrStatus.base64.startsWith('data:') ? qrStatus.base64 : `data:image/png;base64,${qrStatus.base64}`}
                            style={{ width: 220, height: 220, marginTop: t.space[4], background: '#fff', borderRadius: t.radius.md }}
                        />
                    )}
                    {qrStatus?.connected && <p style={{ color: t.color.success }}>El número de estados ya está vinculado.</p>}
                </Card>
            </div>

            <Card>
                <h2 style={sectionTitle}>Grupo e intervalo</h2>
                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', marginTop: t.space[4], alignItems: 'flex-end' }}>
                    <div style={{ flex: '1 1 280px' }}>
                        <div style={label}>Grupo de la instancia</div>
                        <Select
                            value={groupJid}
                            onChange={setGroupJid}
                            placeholder="Elegí un grupo"
                            options={groups.map((g) => ({ value: g.jid, label: `${g.subject} (${g.jid})` }))}
                        />
                    </div>
                    <div style={{ width: 140 }}>
                        <div style={label}>Segundos entre mensajes</div>
                        <Input type="number" min="10" max="3600" value={intervalSeconds} onChange={(e) => setIntervalSeconds(e.target.value)} />
                    </div>
                    <Button onClick={loadGroups} disabled={busy === 'groups'}>Listar grupos</Button>
                    <Button variant="primary" onClick={saveSettings} disabled={busy === 'save' || !groupJid}>Guardar</Button>
                </div>
                {status?.settings?.group_subject && (
                    <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm }}>
                        Guardado: {status.settings.group_subject}
                    </p>
                )}
            </Card>

            <Card>
                <h2 style={sectionTitle}>Armar tanda</h2>
                <div style={{ display: 'flex', gap: t.space[2], marginTop: t.space[3] }}>
                    <Button variant={destino === 'grupo' ? 'primary' : 'secondary'} onClick={() => setDestino('grupo')}>Grupos</Button>
                    <Button variant={destino === 'estado' ? 'primary' : 'secondary'} onClick={() => setDestino('estado')}>Estados</Button>
                </div>
                <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm, marginTop: 10 }}>
                    {destino === 'estado'
                        ? 'Cada producto sale como estado de la otra instancia (otro número): foto, nombre y precio de catálogo, uno cada intervalo. Lo ven los contactos de ese WhatsApp, no los del grupo. La hora es de Argentina.'
                        : 'Entra solo un producto de Odoo con foto y con precio de catálogo (lista del proveedor × 1,015 × markup de la empresa). La lista de cliente filtra proveedores y no cambia ese precio. La hora es de Argentina.'}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: t.space[3], marginTop: t.space[4] }}>
                    <div>
                        <div style={label}>Lista</div>
                        <Select value={company} onChange={setCompany} options={[
                            { value: 'preventas', label: 'Preventas' },
                            { value: 'neggo', label: 'Neggo' },
                        ]} />
                    </div>
                    <div>
                        <div style={label}>Categoría Odoo</div>
                        <Select
                            value={category}
                            onChange={setCategory}
                            options={[{ value: '', label: 'Todas' }, ...filters.categories.map((c) => ({ value: c, label: c }))]}
                        />
                    </div>
                    <div>
                        <div style={label}>Categoría del catálogo</div>
                        <Select
                            value={destCategory}
                            onChange={setDestCategory}
                            options={[{ value: '', label: 'Todas' }, ...filters.dest_categories.map((c) => ({ value: c, label: c }))]}
                        />
                    </div>
                    <div>
                        <div style={label}>Lista de cliente</div>
                        <Select
                            value={pricelistId}
                            onChange={setPricelistId}
                            options={[{ value: '', label: 'Sin filtrar' }, ...filters.pricelists.map((p) => ({ value: String(p.id), label: p.name }))]}
                        />
                    </div>
                    <div>
                        <div style={label}>Fecha y hora</div>
                        <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
                    </div>
                </div>
                <div style={{ display: 'flex', gap: t.space[3], marginTop: t.space[4] }}>
                    <Button onClick={runPreview} disabled={busy === 'preview'}>Ver cuántos entran</Button>
                    <Button
                        variant="primary"
                        leftIcon={<Icon.MessageCircle size={16} />}
                        onClick={schedule}
                        disabled={busy === 'schedule' || (destino === 'grupo' && !groupJid)}
                    >
                        {destino === 'estado' ? 'Programar estados' : 'Programar tanda'}
                    </Button>
                </div>
                {preview && (
                    <div style={{ marginTop: t.space[4] }}>
                        <strong>{preview.count}</strong> productos
                        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: t.color.text }}>
                            {(preview.sample || []).map((p) => (
                                <li key={p.name}>{p.name} — {p.price_label}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </Card>

            <Card padding={false}>
                <div style={{ padding: t.space[5], paddingBottom: t.space[3] }}>
                    <h2 style={sectionTitle}>Tandas</h2>
                </div>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: t.font.family, fontSize: t.font.size.sm }}>
                        <thead>
                            <tr>
                                {['#', 'Dónde', 'Lista', 'Cuándo', 'Progreso', 'Estado', ''].map((h) => (
                                    <th key={h} style={{ textAlign: 'left', padding: '8px 14px', color: t.color.textMuted, fontWeight: t.font.weight.semibold, borderBottom: `1px solid ${t.color.border}` }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {batches.length === 0 && (
                                <tr><td colSpan={7} style={{ padding: 16, color: t.color.textMuted }}>Todavía no hay tandas.</td></tr>
                            )}
                            {batches.map((b) => (
                                <tr key={b.id} style={{ borderBottom: `1px solid ${t.color.border}` }}>
                                    <td style={{ padding: '10px 14px' }}>{b.id}</td>
                                    <td style={{ padding: '10px 14px' }}>{b.destino === 'estado' ? 'Estados' : (b.group_subject || 'Grupo')}</td>
                                    <td style={{ padding: '10px 14px', textTransform: 'capitalize' }}>{b.company}</td>
                                    <td style={{ padding: '10px 14px', ...t.numericStyle }}>{fmtWhen(b.scheduled_at)}</td>
                                    <td style={{ padding: '10px 14px', ...t.numericStyle }}>{b.enviados}/{b.total}{b.errores ? ` · ${b.errores} error` : ''}</td>
                                    <td style={{ padding: '10px 14px' }}><Badge tone={STATUS_TONE[b.status] || 'muted'}>{b.status}</Badge></td>
                                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                                        <Button size="sm" variant="ghost" onClick={() => setOpenId(b.id)}>Ver</Button>
                                        {(b.status === 'programada' || b.status === 'en_curso') && (
                                            <Button size="sm" variant="ghost" onClick={() => act(b.id, 'pause')}>Pausar</Button>
                                        )}
                                        {b.status === 'pausada' && (
                                            <Button size="sm" variant="ghost" onClick={() => act(b.id, 'resume')}>Reanudar</Button>
                                        )}
                                        {b.status !== 'completada' && b.status !== 'cancelada' && (
                                            <Button size="sm" variant="ghost" onClick={() => act(b.id, 'cancel')}>Cancelar</Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {detail && (
                    <div style={{ padding: t.space[5], borderTop: `1px solid ${t.color.border}` }}>
                        <strong>Tanda #{detail.id}</strong>
                        <span style={{ color: t.color.textMuted }}> · {detail.group_subject || detail.group_jid} · cada {detail.interval_seconds} s</span>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: t.space[4], marginTop: t.space[3] }}>
                            <div>
                                {(detail.messages || []).slice(0, 12).map((m) => (
                                    <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: `1px solid ${t.color.border}` }}>
                                        <span>{m.product_name} · {m.price_label}</span>
                                        <Badge tone={STATUS_TONE[m.status] || 'muted'}>{m.status}</Badge>
                                    </div>
                                ))}
                            </div>
                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                {(detail.logs || []).map((l) => (
                                    <div key={l.id}>{fmtWhen(l.created_at)} · {l.message}</div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </Card>
        </div>
    );
}
