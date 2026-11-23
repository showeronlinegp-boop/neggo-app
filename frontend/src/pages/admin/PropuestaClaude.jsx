import { useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';

// Propuesta de publicaciones por temporada armada por Claude (nota 204, solo Neggo).
// "Sugerir con Claude" abre una terminal (tools/claude-link, link neggo-claude://whatsapp/neggo);
// Claude deja el listado y acá se carga en el sorteo de la pantalla.
// para: 'whatsapp' (Generar imágenes del grupo/estados) | 'imagenes' (Imágenes para estados).
const ESPERA_MS = 20 * 60 * 1000;
const CADA_MS = 15000;

export function usePropuestaClaude({ company, para = 'whatsapp', onError, onNotice }) {
    const [propuesta, setPropuesta] = useState(null);
    const [cargadaId, setCargadaId] = useState(null);
    const [esperandoHasta, setEsperandoHasta] = useState(0);
    const [buscando, setBuscando] = useState(false);
    const activa = company === 'neggo';

    async function buscar({ silencioso = false } = {}) {
        if (!silencioso) { setBuscando(true); onError(null); }
        const res = await api.get('/whatsapp/propuestas/ultima', { para });
        if (!silencioso) setBuscando(false);
        if (!res.success) { if (!silencioso) onError(res.error); return null; }
        const p = res.data && res.data.total > 0 ? res.data : null;
        setPropuesta(p);
        if (!silencioso && !p) onNotice('No hay ninguna propuesta de Claude con productos sin usar.');
        return p;
    }

    useEffect(() => {
        setCargadaId(null);
        if (activa) buscar({ silencioso: true });
        else setPropuesta(null);
    }, [company]); // eslint-disable-line react-hooks/exhaustive-deps

    // Mientras Claude trabaja en la terminal, se busca la propuesta sola
    useEffect(() => {
        if (!activa || !esperandoHasta) return undefined;
        const desde = propuesta?.id || 0;
        const timer = setInterval(async () => {
            if (Date.now() > esperandoHasta) { setEsperandoHasta(0); return; }
            const p = await buscar({ silencioso: true });
            if (p && p.id !== desde) {
                setEsperandoHasta(0);
                onNotice(`Claude dejó la propuesta «${p.titulo}» con ${p.total} productos. Tocá «Cargar propuesta».`);
            }
        }, CADA_MS);
        return () => clearInterval(timer);
    }, [company, esperandoHasta]); // eslint-disable-line react-hooks/exhaustive-deps

    function sugerir() {
        onError(null);
        // El pedido a Claude es fijo: el link no lleva datos
        window.location.href = 'neggo-claude://whatsapp/neggo';
        setEsperandoHasta(Date.now() + ESPERA_MS);
        onNotice('Se abre una terminal con Claude. Cuando termine, la propuesta aparece acá sola.');
    }

    // Devuelve los grupos para cargar en el sorteo de la pantalla
    function cargar() {
        setCargadaId(propuesta.id);
        onNotice(propuesta.omitidos
            ? `Propuesta cargada. ${propuesta.omitidos} producto${propuesta.omitidos === 1 ? '' : 's'} ya salió o no se puede publicar y quedó afuera.`
            : 'Propuesta cargada. Revisala como siempre.');
        return propuesta.grupos;
    }

    async function descartar() {
        setBuscando(true); onError(null);
        const res = await api.post(`/whatsapp/propuestas/${propuesta.id}/estado`, { estado: 'descartada' });
        setBuscando(false);
        if (!res.success) { onError(res.error); return false; }
        const eraCargada = cargadaId === propuesta.id;
        setPropuesta(null);
        setCargadaId(null);
        return eraCargada;
    }

    return {
        activa, propuesta, cargadaId, setCargadaId, esperando: !!esperandoHasta, buscando,
        buscar, sugerir, cargar, descartar,
    };
}

// Botones "Sugerir con Claude" y "Buscar propuesta" (solo Neggo)
export function BotonesPropuesta({ prop }) {
    if (!prop.activa) return null;
    return (
        <>
            <Button
                variant="accent"
                leftIcon={<Icon.Bot size={16} />}
                onClick={prop.sugerir}
                title="Abre una terminal con Claude: propone qué publicar según la época del año y las ventas del año pasado"
            >
                Sugerir con Claude
            </Button>
            <Button variant="ghost" leftIcon={<Icon.Search size={16} />} onClick={() => prop.buscar()} disabled={prop.buscando}>
                {prop.esperando ? 'Esperando a Claude…' : 'Buscar propuesta'}
            </Button>
        </>
    );
}

// Recuadro con la propuesta pendiente (mientras no esté cargada en la pantalla)
export function RecuadroPropuesta({ prop, onCargar, onDescartada }) {
    const { tokens: t } = useTheme();
    const p = prop.propuesta;
    if (!prop.activa || !p || p.id === prop.cargadaId) return null;
    return (
        <div style={{
            marginTop: t.space[4],
            padding: t.space[4],
            borderRadius: t.radius.md,
            border: `1px solid ${t.color.primary}`,
            background: t.color.primarySoft,
            display: 'flex',
            flexDirection: 'column',
            gap: t.space[2],
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], color: t.color.primary, fontWeight: t.font.weight.semibold }}>
                <Icon.Bot size={16} /> Propuesta de Claude: {p.titulo}
            </div>
            <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                <span style={t.numericStyle}>{p.total}</span> productos en {p.grupos.length} categoría{p.grupos.length === 1 ? '' : 's'}
                {p.omitidos > 0 && <> · <span style={t.numericStyle}>{p.omitidos}</span> ya salieron</>}
                {' · '}{new Date(p.created_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
            </div>
            {p.resumen && (
                <div style={{ fontSize: t.font.size.sm, color: t.color.text, whiteSpace: 'pre-line' }}>{p.resumen}</div>
            )}
            <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                <Button size="sm" variant="primary" onClick={() => onCargar(prop.cargar())}>
                    Cargar propuesta
                </Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (await prop.descartar()) onDescartada(); }} disabled={prop.buscando}>
                    Descartar
                </Button>
            </div>
        </div>
    );
}

// Motivo de Claude debajo del nombre del producto
export function MotivoClaude({ motivo }) {
    const { tokens: t } = useTheme();
    if (!motivo) return null;
    return (
        <div style={{ fontSize: t.font.size.xs, color: t.color.primary, lineHeight: 1.3 }} title="Por qué lo eligió Claude">
            {motivo}
        </div>
    );
}
