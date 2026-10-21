import { useTheme } from '../../theme/ThemeContext';
import ProductThumb from './ProductThumb';
import * as Icon from './icons';

// Miniatura que abre la foto en grande; sin foto, si se puede, es el botón para cargarla
export default function MiniaturaFoto({ p, size, onVerFoto, onSubirFoto, subiendoFoto }) {
    const { tokens: t } = useTheme();
    if (!p.image_url && onSubirFoto) {
        const subiendo = subiendoFoto === p.odoo_id;
        return (
            <label
                aria-label={`Cargar foto de ${p.name}`}
                title="Cargar foto en Odoo"
                style={{
                    width: size, height: size, flexShrink: 0, boxSizing: 'border-box',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                    borderRadius: t.radius.sm, border: `1px dashed ${t.color.borderStrong}`,
                    background: t.color.surface2, color: t.color.primary,
                    cursor: subiendo ? 'default' : 'pointer', opacity: subiendo ? 0.6 : 1,
                    fontFamily: t.font.family, fontSize: 9, fontWeight: t.font.weight.semibold,
                }}
            >
                {subiendo ? '…' : (
                    <>
                        <Icon.Camera size={Math.round(size * 0.38)} />
                        {size >= 48 && <span>Foto</span>}
                    </>
                )}
                <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={subiendo}
                    style={{ display: 'none' }}
                    onChange={e => { onSubirFoto(p, e.target.files?.[0]); e.target.value = ''; }}
                />
            </label>
        );
    }
    if (!p.image_url) return <ProductThumb imageUrl={p.image_url} size={size} />;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            <button
                type="button"
                onClick={() => onVerFoto(p)}
                aria-label={`Ver foto de ${p.name}`}
                title="Ver foto en grande"
                style={{
                    padding: 0, border: 'none', background: 'none', cursor: 'zoom-in',
                    borderRadius: t.radius.sm, flexShrink: 0, lineHeight: 0,
                }}
            >
                <ProductThumb imageUrl={p.image_url} size={size} />
            </button>
            {onSubirFoto && (
                <label
                    aria-label={`Cambiar foto de ${p.name}`}
                    title="Cambiar la foto en Odoo"
                    style={{
                        fontFamily: t.font.family, fontSize: 9, fontWeight: t.font.weight.semibold,
                        color: t.color.primary, cursor: subiendoFoto === p.odoo_id ? 'default' : 'pointer',
                        opacity: subiendoFoto === p.odoo_id ? 0.6 : 1,
                    }}
                >
                    {subiendoFoto === p.odoo_id ? '…' : 'Cambiar'}
                    <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={subiendoFoto === p.odoo_id}
                        style={{ display: 'none' }}
                        onChange={e => { onSubirFoto(p, e.target.files?.[0]); e.target.value = ''; }}
                    />
                </label>
            )}
        </div>
    );
}
