import { useState, useEffect, useCallback } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';

// Mientras hay un backup pedido o corriendo, se refresca seguido
const POLL_MS = 4000;

function formatFecha(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' })
        + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function formatTamano(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MB`;
    return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('es-AR')} KB`;
}

export default function BackupCard() {
    const { tokens: t } = useTheme();
    const [estado, setEstado] = useState(null);
    const [error, setError] = useState(null);
    const [pidiendo, setPidiendo] = useState(false);

    const cargar = useCallback(async () => {
        const res = await api.get('/backup/estado');
        if (res.success) { setEstado(res.data); setError(null); }
        else setError(res.error || 'No se pudo leer el estado del backup');
    }, []);

    useEffect(() => { cargar(); }, [cargar]);

    const ocupado = Boolean(estado && (estado.pedido_pendiente || estado.en_curso));

    useEffect(() => {
        if (!ocupado) return undefined;
        const id = setInterval(cargar, POLL_MS);
        return () => clearInterval(id);
    }, [ocupado, cargar]);

    async function hacerAhora() {
        setPidiendo(true); setError(null);
        const res = await api.post('/backup/ahora');
        setPidiendo(false);
        if (res.success) setEstado(res.data);
        else setError(res.error || 'No se pudo pedir el backup');
    }

    const label = { fontSize: 11, color: t.color.textFaint, fontWeight: t.font.weight.semibold, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: t.space[1], fontFamily: t.font.family };
    const valor = { fontSize: t.font.size.sm, color: t.color.text, fontWeight: t.font.weight.medium, fontFamily: t.font.family, ...t.numericStyle };
    const caja = { flex: 1, minWidth: 200, border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, padding: `${t.space[3]}px ${t.space[5]}px`, background: t.color.surface2 };

    const manual = estado?.ultimo_manual;
    const resultado = !ocupado && manual && manual.estado !== 'corriendo' ? manual : null;

    return (
        <Card>
            <div style={{ marginBottom: t.space[5] }}>
                <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: 4, fontFamily: t.font.family }}>
                    Backup de la base
                </div>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, lineHeight: 1.6, fontFamily: t.font.family }}>
                    Se hace solo los <strong>viernes a las 15</strong> y se sube a Google Drive. Quedan las últimas 8 copias.
                    Si vas a tocar algo delicado, hacé uno ahora.
                </div>
            </div>

            {estado && !estado.servicio_activo && (
                <div style={{ marginBottom: t.space[4] }}>
                    <Badge tone="warn" dot>El servicio de backup no está corriendo. Levantalo con: docker compose up -d db-backup</Badge>
                </div>
            )}
            {estado?.servicio_activo && estado.drive_configurado === false && (
                <div style={{ marginBottom: t.space[4] }}>
                    <Badge tone="warn" dot>Drive no está configurado: el backup queda solo en la PC. Ver backup/README.md</Badge>
                </div>
            )}

            {estado && (
                <div style={{ display: 'flex', gap: t.space[3], marginBottom: t.space[5], flexWrap: 'wrap' }}>
                    <div style={caja}>
                        <div style={label}>Último backup en Drive</div>
                        <div style={valor}>{estado.ultimo_ok ? formatFecha(estado.ultimo_ok) : 'Todavía ninguno'}</div>
                    </div>
                    <div style={caja}>
                        <div style={label}>Próximo automático</div>
                        <div style={valor}>{estado.proximo_auto ? formatFecha(estado.proximo_auto) : '—'}</div>
                    </div>
                </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                <Button
                    variant="primary"
                    leftIcon={<Icon.Database size={15} />}
                    disabled={!estado?.servicio_activo || ocupado || pidiendo}
                    onClick={hacerAhora}
                >
                    {ocupado || pidiendo ? 'Haciendo backup…' : 'Hacer backup ahora'}
                </Button>

                {ocupado && (
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                        {estado.en_curso ? 'Copiando la base y subiéndola a Drive…' : 'Esperando al servicio de backup…'}
                    </span>
                )}
                {resultado && (
                    <Badge tone={resultado.estado === 'ok' ? 'success' : 'danger'} dot>
                        {resultado.estado === 'ok'
                            ? `Backup listo · ${formatFecha(resultado.fin)}`
                            : resultado.mensaje || 'El backup falló'}
                    </Badge>
                )}
                {error && <Badge tone="danger" dot>{error}</Badge>}
            </div>

            {estado?.backups?.length > 0 && (
                <div style={{ marginTop: t.space[5] }}>
                    <div style={label}>Copias en la PC</div>
                    {estado.backups.map(b => (
                        <div key={b.nombre} style={{
                            display: 'flex', justifyContent: 'space-between', gap: t.space[3],
                            padding: `${t.space[2]}px 0`, borderTop: `1px solid ${t.color.border}`,
                            fontSize: t.font.size.sm, fontFamily: t.font.family,
                        }}>
                            <span style={{ color: t.color.text, fontFamily: t.font.mono, overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.nombre}</span>
                            <span style={{ color: t.color.textMuted, whiteSpace: 'nowrap', ...t.numericStyle }}>{formatTamano(b.bytes)}</span>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}
