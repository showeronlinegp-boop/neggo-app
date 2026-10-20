import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import DataTable from '../../components/common/DataTable';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Select from '../../components/common/Select';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import * as Icon from '../../components/common/icons';

const TYPE_OPTIONS = [
    { value: 'preventas', label: 'Preventas' },
    { value: 'neggo',     label: 'Neggo' },
];

export default function Catalogs() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [catalogs, setCatalogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [categories, setCategories] = useState([]);
    const [type, setType] = useState('preventas');
    const [destCategory, setDestCategory] = useState('');
    const [generating, setGenerating] = useState(false);
    const [generatingAll, setGeneratingAll] = useState(false);
    const [confirmAll, setConfirmAll] = useState(false);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);

    useEffect(() => { fetchCatalogs(); }, [page]);

    useEffect(() => {
        let cancelled = false;
        setDestCategory('');
        api.get('/catalogs/categories', { type }).then(r => {
            if (cancelled) return;
            if (r.success) setCategories(r.data || []);
        });
        return () => { cancelled = true; };
    }, [type]);

    async function fetchCatalogs() {
        setLoading(true);
        const res = await api.get('/catalogs', { limit: 20, offset: (page - 1) * 20 });
        if (res.success) { setCatalogs(res.data || []); setTotal(res.pagination?.total || res.data?.length || 0); }
        setLoading(false);
    }

    async function handleDownload(id, row) {
        try {
            const token = api.getToken();
            const res = await fetch(`/api/catalogs/${id}/download`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) { showToast('Error al descargar el catálogo', 'error'); return; }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `catalogo-${row.category || row.type}-${id}.pdf`;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(url);
        } catch { showToast('Error al descargar el catálogo', 'error'); }
    }

    async function handleGenerate() {
        if (!destCategory) return showToast('Seleccioná una categoría', 'warning');
        setGenerating(true);
        const res = await api.post('/catalogs/generate', { destCategory, type });
        setGenerating(false);
        if (res.success) { showToast(`Catálogo generado: ${res.data.productCount} productos`, 'success'); fetchCatalogs(); }
        else showToast(res.error || 'Error al generar catálogo', 'error');
    }

    async function handleGenerateAll() {
        setGeneratingAll(true);
        const res = await api.post('/catalogs/generate', { all: true, type });
        setGeneratingAll(false);
        setConfirmAll(false);
        if (res.success) { showToast(`${res.data.generados}/${res.data.total} catálogos generados`, 'success'); fetchCatalogs(); }
        else showToast(res.error || 'Error al generar catálogos', 'error');
    }

    const categoryOptions = [
        { value: '', label: 'Seleccioná…' },
        ...categories.map(c => ({ value: c, label: c })),
    ];

    const cols = [
        {
            key: 'type',
            label: 'Tipo',
            render: v => <Badge tone={v === 'neggo' ? 'primary' : 'accent'}>{v || '—'}</Badge>,
        },
        { key: 'category', label: 'Categoría', render: v => v || '—' },
        { key: 'product_count', label: 'Productos', render: v => <span style={t.numericStyle}>{v}</span> },
        { key: 'created_at', label: 'Fecha', render: v => new Date(v).toLocaleDateString('es-AR') },
        {
            key: 'id',
            label: '',
            render: (v, row) => (
                <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Icon.ArrowRight size={13} />}
                    onClick={e => { e.stopPropagation(); handleDownload(v, row); }}
                >
                    Descargar
                </Button>
            ),
        },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Generador */}
            <Card>
                <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: t.space[5], fontFamily: t.font.family }}>
                    Generar catálogo
                </div>
                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div>
                        <label style={{ display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[1], fontFamily: t.font.family }}>
                            Tipo
                        </label>
                        <Select value={type} onChange={setType} options={TYPE_OPTIONS} style={{ width: 160 }} />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[1], fontFamily: t.font.family }}>
                            Categoría *
                        </label>
                        <Select value={destCategory} onChange={setDestCategory} options={categoryOptions} style={{ width: 220 }} />
                    </div>
                    <Button
                        variant="primary"
                        leftIcon={<Icon.FileText size={15} />}
                        disabled={generating || generatingAll || !destCategory}
                        onClick={handleGenerate}
                    >
                        {generating ? 'Generando…' : 'Generar'}
                    </Button>
                    <Button
                        variant="secondary"
                        leftIcon={<Icon.Package size={15} />}
                        disabled={generating || generatingAll || categories.length === 0}
                        onClick={() => setConfirmAll(true)}
                    >
                        {generatingAll ? 'Generando todos…' : 'Generar todos'}
                    </Button>
                </div>
                {categories.length === 0 && (
                    <div style={{ marginTop: t.space[4], fontSize: t.font.size.sm, color: t.color.warn, fontFamily: t.font.family }}>
                        Sin categorías configuradas. Configurá las reglas de categoría en cada proveedor primero.
                    </div>
                )}
            </Card>

            <DataTable
                columns={cols}
                data={catalogs}
                loading={loading}
                pagination={{ page, pageSize: 20, total }}
                onPageChange={setPage}
            />

            <ConfirmDialog
                isOpen={confirmAll}
                onClose={() => setConfirmAll(false)}
                onConfirm={handleGenerateAll}
                title="Generar todos los catálogos"
                message={`¿Generás catálogos para todas las categorías disponibles? (${categories.length} categorías). Esto puede tardar varios minutos.`}
                confirmLabel={generatingAll ? 'Generando…' : 'Generar todos'}
            />
        </div>
    );
}
