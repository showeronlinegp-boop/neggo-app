import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ingresoAPI } from '../api/ingresoClient';
import api from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Input from '../components/common/Input';
import Select from '../components/common/Select';
import * as Icon from '../components/common/icons';

const COMPROBANTE_OPTS = [
    { value: 'factura', label: 'Factura' },
    { value: 'remito',  label: 'Remito' },
    { value: 'nota',    label: 'Nota de crédito' },
];

export default function IngresoUpload() {
    const { tokens: t } = useTheme();
    const navigate = useNavigate();
    const fileInputRef = useRef(null);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [file, setFile] = useState(null);
    const [dragging, setDragging] = useState(false);
    const [supplierId, setSupplierId] = useState('');
    const [comprobanteTipo, setComprobanteTipo] = useState('factura');
    const [comprobantNumero, setComprobantNumero] = useState('');
    const [suppliers, setSuppliers] = useState([]);
    const [loadingSuppliers, setLoadingSuppliers] = useState(true);

    useEffect(() => {
        api.get('/suppliers', { limit: 200 })
            .then(res => { if (res.success) setSuppliers(res.data?.data || res.data || []); })
            .catch(() => {})
            .finally(() => setLoadingSuppliers(false));
    }, []);

    const selectedSupplier = suppliers.find(s => String(s.id) === String(supplierId));

    function handleFileChange(selectedFile) {
        if (!selectedFile) return;
        if (!selectedFile.name.toLowerCase().endsWith('.csv')) { setError('Solo archivos CSV permitidos'); return; }
        setError(null); setFile(selectedFile);
    }

    function handleDrop(e) {
        e.preventDefault(); setDragging(false);
        const dropped = e.dataTransfer.files[0];
        if (dropped) handleFileChange(dropped);
    }

    async function handleSubmit(e) {
        e.preventDefault(); setError(null);
        if (!file) { setError('Seleccioná un archivo CSV'); return; }
        setLoading(true);
        try {
            const result = await ingresoAPI.uploadCSV(file, supplierId, comprobanteTipo, comprobantNumero);
            if (result.success) navigate(`/ingreso/${result.data.ingreso_id}`);
            else setError(result.error || 'Error al procesar CSV');
        } catch (err) { setError(err.message || 'Error de conexión'); }
        finally { setLoading(false); }
    }

    const labelStyle = { display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[2], fontFamily: t.font.family };
    const nativeSelectStyle = { width: '100%', padding: '8px 12px', border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.base, fontFamily: t.font.family, color: t.color.text, background: t.color.surface, boxSizing: 'border-box', height: t.layout.inputHeight };

    return (
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            <Card>
                <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: t.space[6], fontFamily: t.font.family }}>
                    Nuevo comprobante
                </div>

                {error && (
                    <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '12px 14px', borderRadius: t.radius.sm, marginBottom: t.space[5], fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    {/* Drag & drop */}
                    <div style={{ marginBottom: t.space[6] }}>
                        <label style={labelStyle}>Archivo CSV *</label>
                        <div
                            onClick={() => fileInputRef.current?.click()}
                            onDragOver={e => { e.preventDefault(); setDragging(true); }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={handleDrop}
                            style={{
                                border: `2px dashed ${dragging ? t.color.primary : file ? t.color.success : t.color.borderStrong}`,
                                borderRadius: t.radius.sm,
                                padding: '32px 16px',
                                textAlign: 'center',
                                cursor: 'pointer',
                                background: dragging ? t.color.primarySoft : file ? t.color.successSoft : t.color.surface2,
                                transition: 'all 0.2s',
                            }}
                        >
                            <input ref={fileInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => handleFileChange(e.target.files?.[0])} />
                            {file ? (
                                <>
                                    <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
                                    <div style={{ fontWeight: t.font.weight.semibold, color: t.color.success, fontSize: t.font.size.sm, fontFamily: t.font.family }}>{file.name}</div>
                                    <div style={{ color: t.color.textMuted, fontSize: t.font.size.xs, marginTop: 4, fontFamily: t.font.family }}>{(file.size / 1024).toFixed(1)} KB · Click para cambiar</div>
                                </>
                            ) : (
                                <>
                                    <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
                                    <div style={{ color: t.color.text, fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, fontFamily: t.font.family }}>Arrastrá el CSV acá o hacé click para seleccionarlo</div>
                                    <div style={{ color: t.color.textMuted, fontSize: t.font.size.xs, marginTop: 4, fontFamily: t.font.family }}>Máximo 5MB</div>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Proveedor */}
                    <div style={{ marginBottom: t.space[5] }}>
                        <label style={labelStyle}>Proveedor</label>
                        <select value={supplierId} onChange={e => setSupplierId(e.target.value)} style={nativeSelectStyle}>
                            <option value="">-- Sin especificar --</option>
                            {loadingSuppliers ? <option disabled>Cargando…</option> : suppliers.map(s => <option key={s.id} value={s.id}>{s.name}{s.prefix ? ` (${s.prefix})` : ''}</option>)}
                        </select>
                        {selectedSupplier && (
                            <div style={{ display: 'flex', gap: t.space[6], marginTop: t.space[2], fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                                <span>Descuento: <strong style={{ color: t.color.text }}>{selectedSupplier.default_discount || 0}%</strong></span>
                                <span>Markup: <strong style={{ color: t.color.text }}>{selectedSupplier.default_markup || 0}%</strong></span>
                                {!selectedSupplier.website_url && <span style={{ color: t.color.warn }}>Sin scraper</span>}
                            </div>
                        )}
                    </div>

                    {/* Tipo + número */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: t.space[5], marginBottom: t.space[6] }}>
                        <div>
                            <label style={labelStyle}>Tipo de comprobante *</label>
                            <Select value={comprobanteTipo} onChange={setComprobanteTipo} options={COMPROBANTE_OPTS} />
                        </div>
                        <div>
                            <label style={labelStyle}>Número de comprobante</label>
                            <Input value={comprobantNumero} onChange={e => setComprobantNumero(e.target.value)} placeholder="Ej: F-001234" />
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: t.space[2] }}>
                        <Button type="submit" variant="primary" disabled={loading || !file} leftIcon={<Icon.Check size={15} />}>
                            {loading ? 'Procesando…' : 'Procesar CSV'}
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => navigate('/ingreso')}>
                            Cancelar
                        </Button>
                    </div>
                </form>
            </Card>

            {/* Formato esperado */}
            <Card>
                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[3], fontFamily: t.font.family }}>
                    Formato esperado del CSV
                </div>
                <pre style={{
                    background: t.color.surface2,
                    border: `1px solid ${t.color.border}`,
                    borderRadius: t.radius.sm,
                    padding: t.space[5],
                    fontSize: t.font.size.xs,
                    fontFamily: t.font.mono,
                    color: t.color.text,
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                }}>
{`Codigo,Descripcion,Cantidad,Precio unitario,Subtotal
SKU-001,Producto A,10,1500.00,15000.00
SKU-002,Producto B,5,2500,12500
,Producto sin codigo,3,800,2400`}
                </pre>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: t.space[3], fontFamily: t.font.family }}>
                    El código es opcional. Acepta formatos numéricos con punto o coma ("1.500,00" y "1500.00").
                </div>
            </Card>
        </div>
    );
}
