import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

const ToastContext = createContext(null);

// ─── Colores por tipo ─────────────────────────────────────────────────────────
const TOAST_STYLES = {
    success: { bg: '#D4EDDA', text: '#155724', border: '#C3E6CB' },
    error:   { bg: '#FDECEA', text: '#721C24', border: '#F5C6CB' },
    warning: { bg: '#FFF3CD', text: '#856404', border: '#FFEEBA' },
    info:    { bg: '#D1ECF1', text: '#0C5460', border: '#BEE5EB' },
};

const ICONS = {
    success: '✅',
    error:   '❌',
    warning: '⚠️',
    info:    'ℹ️',
};

// ─── Componente individual de Toast ──────────────────────────────────────────
function ToastItem({ toast, onRemove }) {
    const { bg, text, border } = TOAST_STYLES[toast.type] ?? TOAST_STYLES.info;

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '12px 14px',
                borderRadius: '8px',
                backgroundColor: bg,
                color: text,
                border: `1px solid ${border}`,
                boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                minWidth: '280px',
                maxWidth: '420px',
                fontSize: '14px',
                lineHeight: '1.4',
                animation: 'neggo-toast-in 0.22s ease-out',
            }}
            role="alert"
        >
            <span style={{ fontSize: '16px', flexShrink: 0, lineHeight: '1.4' }}>
                {ICONS[toast.type] ?? 'ℹ️'}
            </span>
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button
                onClick={() => onRemove(toast.id)}
                style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    fontSize: '18px',
                    cursor: 'pointer',
                    opacity: 0.7,
                    padding: 0,
                    lineHeight: 1,
                    flexShrink: 0,
                    alignSelf: 'center',
                }}
                aria-label="Cerrar notificación"
                type="button"
            >
                ×
            </button>
        </div>
    );
}

// ─── Provider ─────────────────────────────────────────────────────────────────
export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    const timersRef = useRef({});

    // Inyectar keyframe una sola vez
    useEffect(() => {
        const STYLE_ID = 'neggo-toast-kf';
        if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
            const tag = document.createElement('style');
            tag.id = STYLE_ID;
            tag.textContent = `
                @keyframes neggo-toast-in {
                    from { opacity: 0; transform: translateY(12px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
            `;
            document.head.appendChild(tag);
        }
    }, []);

    const removeToast = useCallback((id) => {
        clearTimeout(timersRef.current[id]);
        delete timersRef.current[id];
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const showToast = useCallback((message, type = 'info') => {
        const id = Date.now() + Math.random();
        setToasts((prev) => [...prev, { id, message, type }]);

        // Auto-dismiss en 4 segundos
        timersRef.current[id] = setTimeout(() => removeToast(id), 4000);
    }, [removeToast]);

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}

            {/* Contenedor de toasts — esquina inferior derecha */}
            <div
                style={{
                    position: 'fixed',
                    bottom: '24px',
                    right: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    zIndex: 9999,
                    pointerEvents: 'none',
                }}
                aria-live="polite"
            >
                {toasts.map((t) => (
                    <div key={t.id} style={{ pointerEvents: 'auto' }}>
                        <ToastItem toast={t} onRemove={removeToast} />
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast debe usarse dentro de un ToastProvider');
    }
    return context;
}
