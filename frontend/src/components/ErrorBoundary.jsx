import { Component } from 'react';
import { getTokens } from '../theme/tokens';

const { color: C, font, radius, shadow } = getTokens('light');

/**
 * Captura errores de lazy-loading de chunks (ChunkLoadError) y cualquier otro
 * error de render. Para ChunkLoadError recarga la página automáticamente una vez.
 * Para otros errores muestra un mensaje con botón de recarga manual.
 */
export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, chunkError: false, reloading: false };
    }

    static getDerivedStateFromError(error) {
        const isChunkError =
            error?.name === 'ChunkLoadError' ||
            error?.message?.includes('Loading chunk') ||
            error?.message?.includes('Failed to fetch dynamically imported module') ||
            error?.message?.includes('Importing a module script failed');

        return { hasError: true, chunkError: isChunkError };
    }

    componentDidCatch(error, info) {
        if (this.state.chunkError && !this.state.reloading) {
            // Chunk obsoleto por nuevo deploy → recargar una sola vez
            this.setState({ reloading: true });
            // Pequeño delay para que el SW pueda activarse con los chunks nuevos
            setTimeout(() => window.location.reload(), 500);
        } else {
            console.error('ErrorBoundary capturó un error:', error, info);
        }
    }

    render() {
        if (!this.state.hasError) return this.props.children;

        if (this.state.chunkError) {
            return (
                <div style={s.container}>
                    <div style={s.card}>
                        <div style={s.icon}>⏳</div>
                        <h2 style={s.title}>Actualizando la aplicación...</h2>
                        <p style={s.text}>Hay una nueva versión disponible. La página se va a recargar en un momento.</p>
                    </div>
                </div>
            );
        }

        return (
            <div style={s.container}>
                <div style={s.card}>
                    <div style={s.icon}>⚠️</div>
                    <h2 style={s.title}>Algo salió mal</h2>
                    <p style={s.text}>Ocurrió un error inesperado en esta sección.</p>
                    <button onClick={() => window.location.reload()} style={s.btn}>
                        Recargar página
                    </button>
                </div>
            </div>
        );
    }
}

const s = {
    container: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        background: C.bg,
        padding: 24,
    },
    card: {
        background: C.surface,
        borderRadius: radius.lg,
        border: `1px solid ${C.border}`,
        padding: '40px 48px',
        textAlign: 'center',
        boxShadow: shadow.pop,
        maxWidth: 400,
    },
    icon: { fontSize: 48, marginBottom: 16 },
    title: { margin: '0 0 12px', color: C.text, fontSize: font.size.xl, fontWeight: font.weight.semibold, fontFamily: font.family },
    text: { margin: '0 0 24px', color: C.textMuted, fontSize: font.size.base, lineHeight: 1.6, fontFamily: font.family },
    btn: {
        padding: '10px 24px',
        background: C.primary,
        color: '#fff',
        border: 'none',
        borderRadius: radius.sm,
        cursor: 'pointer',
        fontSize: font.size.base,
        fontWeight: font.weight.semibold,
        fontFamily: font.family,
    },
};
