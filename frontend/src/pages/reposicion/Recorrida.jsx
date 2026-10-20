import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

// Recorrida de depósito: escaneá con cámara (BarcodeDetector) o pistola USB (HID)
// y marcá «queda poco» → origen recorrida en la cola.

const SOPORTA_CAMERA = typeof window !== 'undefined'
    && 'BarcodeDetector' in window
    && navigator.mediaDevices?.getUserMedia;

export default function Recorrida() {
    const { tokens: t } = useTheme();
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const detectorRef = useRef(null);
    const rafRef = useRef(null);
    const ultimoCode = useRef('');
    const ultimoAt = useRef(0);
    const hidBuffer = useRef('');
    const hidTimer = useRef(null);

    const [camaraOn, setCamaraOn] = useState(false);
    const [camaraError, setCamaraError] = useState(null);
    const [manual, setManual] = useState('');
    const [producto, setProducto] = useState(null);
    const [buscando, setBuscando] = useState(false);
    const [agregando, setAgregando] = useState(false);
    const [error, setError] = useState(null);
    const [aviso, setAviso] = useState(null);
    const [historial, setHistorial] = useState([]);

    const detenerCamara = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        streamRef.current?.getTracks().forEach(tr => tr.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCamaraOn(false);
    }, []);

    useEffect(() => () => detenerCamara(), [detenerCamara]);

    const buscarCode = useCallback(async (code) => {
        const c = String(code || '').trim();
        if (!c) return;
        // Evitar re-disparos del mismo código en < 2.5s
        if (c === ultimoCode.current && Date.now() - ultimoAt.current < 2500) return;
        ultimoCode.current = c;
        ultimoAt.current = Date.now();

        setBuscando(true);
        setError(null);
        setAviso(null);
        setProducto(null);
        const res = await api.get('/reposicion/barcode', { code: c });
        setBuscando(false);
        if (!res.success) {
            setError(res.error || `No encontré el código ${c}`);
            return;
        }
        setProducto(res.data);
        setManual(c);
    }, []);

    const iniciarCamara = async () => {
        setCamaraError(null);
        if (!SOPORTA_CAMERA) {
            setCamaraError('Este navegador no soporta escáner de cámara. Usá la pistola USB o escribí el código.');
            return;
        }
        try {
            detectorRef.current = new window.BarcodeDetector({
                formats: ['ean_13', 'ean_8', 'code_128', 'upc_a', 'upc_e', 'qr_code'],
            });
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
                audio: false,
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setCamaraOn(true);

            const tick = async () => {
                if (!videoRef.current || videoRef.current.readyState < 2) {
                    rafRef.current = requestAnimationFrame(tick);
                    return;
                }
                try {
                    const codes = await detectorRef.current.detect(videoRef.current);
                    if (codes?.[0]?.rawValue) await buscarCode(codes[0].rawValue);
                } catch {
                    // frame fallido: seguir
                }
                rafRef.current = requestAnimationFrame(tick);
            };
            rafRef.current = requestAnimationFrame(tick);
        } catch (err) {
            setCamaraError(err.message || 'No se pudo abrir la cámara');
            detenerCamara();
        }
    };

    // Pistola USB (HID): acumula teclas rápidas y Enter dispara la búsqueda
    useEffect(() => {
        const onKey = (e) => {
            if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
            if (e.key === 'Enter') {
                const code = hidBuffer.current;
                hidBuffer.current = '';
                if (code.length >= 4) buscarCode(code);
                return;
            }
            if (e.key.length === 1) {
                hidBuffer.current += e.key;
                clearTimeout(hidTimer.current);
                hidTimer.current = setTimeout(() => { hidBuffer.current = ''; }, 120);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            clearTimeout(hidTimer.current);
        };
    }, [buscarCode]);

    const marcarQuedaPoco = async () => {
        if (!producto) return;
        setAgregando(true);
        setError(null);
        const res = await api.post('/reposicion', { odoo_id: producto.odoo_id, origen: 'recorrida' });
        setAgregando(false);
        if (!res.success) {
            setError(res.error || 'No se pudo agregar a la cola');
            return;
        }
        setAviso(`«${producto.name}» entró a la cola (recorrida).`);
        setHistorial(prev => [{ ...res.data, scanned_at: new Date().toISOString() }, ...prev].slice(0, 20));
        setProducto(prev => prev ? { ...prev, en_cola: true } : prev);
    };

    // Deshace un «Queda poco» marcado por error
    const quitarDeCola = async () => {
        if (!producto) return;
        setAgregando(true);
        setError(null);
        const res = await api.del(`/reposicion/producto/${producto.odoo_id}`);
        setAgregando(false);
        if (!res.success) {
            setError(res.error || 'No se pudo sacar de la cola');
            return;
        }
        setAviso(`«${producto.name}» salió de la cola.`);
        setHistorial(prev => prev.filter(h => h.odoo_id !== producto.odoo_id));
        setProducto(prev => prev ? { ...prev, en_cola: false, estado_cola: null } : prev);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5], maxWidth: 640, margin: '0 auto', width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                <div>
                    <div style={{ fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                        Recorrida de depósito
                    </div>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, marginTop: 2 }}>
                        Escaneá lo que queda flojo y mandalo a la cola de reposición.
                    </div>
                </div>
                <Link to="/reposicion" style={{ textDecoration: 'none' }}>
                    <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />}>Ver cola</Button>
                </Link>
            </div>

            <Card padding={false} style={{ overflow: 'hidden' }}>
                <div style={{ position: 'relative', background: '#111', aspectRatio: '4 / 3' }}>
                    <video
                        ref={videoRef}
                        muted
                        playsInline
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: camaraOn ? 'block' : 'none' }}
                    />
                    {!camaraOn && (
                        <div style={{
                            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                            alignItems: 'center', justifyContent: 'center', gap: t.space[3], padding: t.space[5],
                            color: '#ccc', fontFamily: t.font.family, textAlign: 'center',
                        }}>
                            <Icon.Camera size={36} color="#888" />
                            <div style={{ fontSize: t.font.size.sm }}>
                                {SOPORTA_CAMERA
                                    ? 'Abrí la cámara trasera para escanear, o usá la pistola USB.'
                                    : 'Cámara no disponible en este navegador. Usá pistola USB o el campo de abajo.'}
                            </div>
                            {SOPORTA_CAMERA && (
                                <Button size="sm" variant="primary" leftIcon={<Icon.Camera size={13} />} onClick={iniciarCamara}>
                                    Abrir cámara
                                </Button>
                            )}
                        </div>
                    )}
                    {camaraOn && (
                        <div style={{
                            position: 'absolute', left: '10%', right: '10%', top: '35%', height: 2,
                            background: 'rgba(255,102,0,0.85)', boxShadow: '0 0 8px rgba(255,102,0,0.6)',
                        }} />
                    )}
                </div>
                <div style={{ padding: t.space[4], display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    {camaraOn ? (
                        <Button size="sm" variant="ghost" onClick={detenerCamara}>Cerrar cámara</Button>
                    ) : SOPORTA_CAMERA ? (
                        <Button size="sm" variant="secondary" leftIcon={<Icon.Camera size={13} />} onClick={iniciarCamara}>
                            Abrir cámara
                        </Button>
                    ) : null}
                    <div style={{ flex: 1, minWidth: 180 }}>
                        <Input
                            value={manual}
                            onChange={e => setManual(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') buscarCode(manual); }}
                            placeholder="Código de barras…"
                            leftIcon={<Icon.ScanBarcode size={14} />}
                        />
                    </div>
                    <Button size="sm" variant="primary" disabled={buscando || !manual.trim()}
                        onClick={() => buscarCode(manual)}>
                        Buscar
                    </Button>
                </div>
                {camaraError && (
                    <div style={{ padding: `0 ${t.space[4]} ${t.space[4]}`, fontSize: t.font.size.xs, color: t.color.danger, fontFamily: t.font.family }}>
                        {camaraError}
                    </div>
                )}
            </Card>

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

            {buscando && (
                <Card><div style={{ padding: 24, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>Buscando…</div></Card>
            )}

            {producto && !buscando && (
                <Card style={{ display: 'flex', gap: t.space[4], alignItems: 'center', flexWrap: 'wrap' }}>
                    <ProductThumb imageUrl={producto.image_url} size={72} />
                    <div style={{ flex: 1, minWidth: 160, fontFamily: t.font.family }}>
                        <div style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontSize: t.font.size.base }}>
                            {producto.name}
                        </div>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 4 }}>
                            <span style={{ fontFamily: t.font.mono }}>{producto.barcode || producto.internal_ref || '—'}</span>
                            {' · '}{producto.vendor_name}
                        </div>
                        <div style={{ marginTop: t.space[2], display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                            {producto.es_liquidar && <Badge tone="muted">Liquidar</Badge>}
                            {producto.en_cola && <Badge tone="success" dot>Ya en la cola</Badge>}
                        </div>
                    </div>
                    {producto.es_liquidar ? (
                        <Badge tone="muted">No se repone</Badge>
                    ) : producto.estado_cola === 'encargado' ? (
                        <Badge tone="accent" dot>Encargado</Badge>
                    ) : producto.en_cola ? (
                        <Button
                            variant="secondary"
                            leftIcon={<Icon.X size={14} />}
                            disabled={agregando}
                            onClick={quitarDeCola}
                        >
                            No reponer
                        </Button>
                    ) : (
                        <Button
                            variant="primary"
                            leftIcon={<Icon.Plus size={14} />}
                            disabled={agregando}
                            onClick={marcarQuedaPoco}
                        >
                            Queda poco
                        </Button>
                    )}
                </Card>
            )}

            {historial.length > 0 && (
                <Card padding={false}>
                    <div style={{ padding: '12px 16px', fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm, fontFamily: t.font.family, color: t.color.text }}>
                        Marcados en esta sesión ({historial.length})
                    </div>
                    {historial.map(h => (
                        <div key={h.id} style={{
                            display: 'flex', alignItems: 'center', gap: t.space[3],
                            padding: '10px 16px', borderTop: `1px solid ${t.color.border}`, fontFamily: t.font.family,
                        }}>
                            <ProductThumb imageUrl={h.image_url} size={36} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {h.name}
                                </div>
                                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{h.vendor_name}</div>
                            </div>
                            <Badge tone="warn" dot>Recorrida</Badge>
                        </div>
                    ))}
                </Card>
            )}
        </div>
    );
}
