import { useEffect, useState } from 'react';
import { useTheme } from '../../theme/ThemeContext';
import * as Icon from './icons';

// Las fotos de Odoo pasan por /api/products/odoo-image/..., que acepta ?size= para traer
// la versión grande. Cualquier otra URL se muestra tal cual.
export function urlFotoGrande(url) {
    if (!url) return url;
    if (!/^\/api\/products\/odoo-image\//.test(url)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}size=1024`;
}

// Visor de foto a pantalla completa. Se puede abrir encima de otro Modal: Escape y el
// clic afuera cierran solo el visor.
export default function FotoAmpliada({ imageUrl, nombre, detalle, onClose }) {
    const { tokens: t } = useTheme();
    const [src, setSrc] = useState(null);
    const [cargando, setCargando] = useState(true);
    const [sinFoto, setSinFoto] = useState(false);

    useEffect(() => {
        setSrc(imageUrl ? urlFotoGrande(imageUrl) : null);
        setCargando(true);
        setSinFoto(false);
    }, [imageUrl]);

    useEffect(() => {
        if (!imageUrl) return;
        // En captura sobre window para que el Escape no llegue al Modal de abajo
        const handler = (e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose?.();
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [imageUrl, onClose]);

    if (!imageUrl) return null;

    const errorImagen = () => {
        // Si la versión grande falla, probamos con la chica antes de rendirnos
        if (src !== imageUrl) { setSrc(imageUrl); return; }
        setCargando(false);
        setSinFoto(true);
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={nombre ? `Foto de ${nombre}` : 'Foto del producto'}
            onClick={(e) => { e.stopPropagation(); onClose?.(); }}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 200,
                background: 'rgba(20,20,18,0.82)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: t.space[3],
                padding: '56px 16px 24px',
                cursor: 'zoom-out',
            }}
        >
            <button
                type="button"
                aria-label="Cerrar"
                onClick={(e) => { e.stopPropagation(); onClose?.(); }}
                style={{
                    position: 'absolute', top: 12, right: 12,
                    width: 40, height: 40, borderRadius: '50%',
                    border: 'none', cursor: 'pointer',
                    background: t.color.surface, color: t.color.text,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: t.shadow.pop,
                }}
            >
                <Icon.X size={18} />
            </button>

            <div
                onClick={e => e.stopPropagation()}
                style={{
                    background: t.color.surface,
                    borderRadius: t.radius.lg,
                    padding: t.space[4],
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: t.space[3],
                    maxWidth: '100%',
                    cursor: 'default',
                    boxShadow: t.shadow.pop,
                }}
            >
                {/* Caja fija: aunque Odoo solo tenga la foto chica, se ve grande */}
                <div style={{
                    position: 'relative',
                    width: 'min(88vw, 640px)',
                    height: 'min(calc(100dvh - 200px), 640px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    {sinFoto ? (
                        <div style={{ color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                            No pudimos cargar la foto.
                        </div>
                    ) : (
                        <>
                            {cargando && (
                                <div style={{ position: 'absolute', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                                    Cargando foto…
                                </div>
                            )}
                            <img
                                src={src}
                                alt={nombre || ''}
                                onLoad={() => setCargando(false)}
                                onError={errorImagen}
                                style={{
                                    width: '100%', height: '100%',
                                    objectFit: 'contain',
                                    opacity: cargando ? 0 : 1,
                                    transition: 'opacity 120ms ease',
                                }}
                            />
                        </>
                    )}
                </div>

                {(nombre || detalle) && (
                    <div style={{ textAlign: 'center', width: 'min(88vw, 640px)', fontFamily: t.font.family }}>
                        {nombre && (
                            <div style={{ color: t.color.text, fontSize: t.font.size.base, fontWeight: t.font.weight.semibold }}>
                                {nombre}
                            </div>
                        )}
                        {detalle && (
                            <div style={{ color: t.color.textMuted, fontSize: t.font.size.xs, fontFamily: t.font.mono, marginTop: 2 }}>
                                {detalle}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
