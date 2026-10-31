import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtInt } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/common/Button';
import Badge from '../../components/common/Badge';
import * as Icon from '../../components/common/icons';

// Aviso de precios viejos en la cola: los proveedores con ofertas de estos productos que no se
// scrapean hace una semana o más. "Actualizar precios" encola esos scrapers (o reanuda el pausado)
// y, mientras corren, se consulta cada 15 s. Al terminar, recarga la cola con los precios nuevos.

const CADA_MS = 15000;

const haceDias = (d) => d == null ? 'nunca' : d === 0 ? 'hoy' : d === 1 ? 'hace 1 día' : `hace ${d} días`;

export default function ReposicionPrecios({ isMobile, onActualizado, onError }) {
    const { tokens: t } = useTheme();
    const { user } = useAuth();
    const [estado, setEstado] = useState(null);
    const [enviando, setEnviando] = useState(false);
    const [aviso, setAviso] = useState(null);
    const corriendo = useRef(false);

    const cargar = useCallback(async () => {
        const res = await api.get('/reposicion/precios');
        if (!res.success) return;
        setEstado(res.data);
        // Terminaron los que estaban corriendo: la cola se recarga con los precios nuevos
        if (corriendo.current && res.data.n_en_curso === 0) {
            corriendo.current = false;
            setAviso('Listo: los precios se actualizaron.');
            onActualizado?.();
        }
        if (res.data.n_en_curso > 0) corriendo.current = true;
    }, [onActualizado]);

    useEffect(() => { cargar(); }, [cargar]);

    useEffect(() => {
        if (!estado?.n_en_curso) return undefined;
        const id = setInterval(cargar, CADA_MS);
        return () => clearInterval(id);
    }, [estado?.n_en_curso, cargar]);

    const actualizar = async () => {
        setEnviando(true);
        setAviso(null);
        const res = await api.post('/reposicion/precios/actualizar', {});
        setEnviando(false);
        if (!res.success) { onError?.(res.error || 'No se pudieron actualizar los precios'); return; }
        const { encolados, errores } = res.data;
        if (errores.length) onError?.(errores.map(e => `${e.proveedor}: ${e.error}`).join(' · '));
        if (encolados.length) {
            corriendo.current = true;
            setAviso(`Actualizando ${encolados.map(e => e.proveedor).join(', ')}. Puede tardar unos minutos.`);
        }
        cargar();
    };

    if (!estado || !estado.proveedores.length) return null;

    const viejos = estado.proveedores.filter(p => p.viejo && !p.en_curso);
    const enCurso = estado.proveedores.filter(p => p.en_curso);
    const alDia = !viejos.length && !enCurso.length;
    const esAdmin = user?.role === 'admin';

    if (alDia) {
        return (
            <div style={{
                fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family,
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: isMobile ? '0 12px' : undefined,
            }}>
                <Icon.Check size={14} color={t.color.success} />
                {aviso || `Precios al día (${fmtInt(estado.proveedores.length)} proveedores con ofertas en la cola)`}
            </div>
        );
    }

    return (
        <div style={{
            background: enCurso.length ? t.color.surface2 : t.color.warnSoft,
            border: `1px solid ${t.color.border}`,
            borderRadius: t.radius.sm,
            padding: '12px 16px',
            margin: isMobile ? '0 12px' : undefined,
            display: 'flex', flexDirection: 'column', gap: t.space[2],
            fontFamily: t.font.family,
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.text, ...t.numericStyle }}>
                    {enCurso.length ? (
                        <>Actualizando precios de <b>{fmtInt(enCurso.length)}</b> proveedor{enCurso.length === 1 ? '' : 'es'}…</>
                    ) : (
                        <>
                            <b>{fmtInt(estado.productos_con_precio_viejo)}</b> producto{estado.productos_con_precio_viejo === 1 ? '' : 's'} de la cola
                            {' '}tienen precios de hace {estado.dias_precio_viejo} días o más. «Conviene otro proveedor» puede estar desactualizado.
                        </>
                    )}
                </div>
                {viejos.length > 0 && esAdmin && (
                    <Button size="sm" variant="primary" leftIcon={<Icon.Refresh size={13} />} onClick={actualizar} disabled={enviando}>
                        {enviando ? 'Encolando…' : 'Actualizar precios'}
                    </Button>
                )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {estado.proveedores.filter(p => p.viejo || p.en_curso).map(p => (
                    <Badge key={p.supplier_id} tone={p.en_curso ? 'accent' : p.se_puede_scrapear ? 'warn' : 'muted'} dot>
                        {p.proveedor} · {p.en_curso ? 'en curso' : haceDias(p.dias)}
                        {!p.se_puede_scrapear && !p.en_curso ? ' · scraping apagado' : ''}
                        {p.pausado && !p.en_curso ? ' · en pausa' : ''}
                    </Badge>
                ))}
            </div>
            {aviso && <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{aviso}</div>}
            {!esAdmin && viejos.length > 0 && (
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                    Pedile a un administrador que actualice los precios.
                </div>
            )}
        </div>
    );
}
