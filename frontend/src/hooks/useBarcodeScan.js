import { useEffect, useRef } from 'react';

// Pistola USB (HID): teclas rápidas + Enter. Ignora si el foco está en un input.

export default function useBarcodeScan(onScan, { enabled = true } = {}) {
    const buf = useRef('');
    const timer = useRef(null);
    const onScanRef = useRef(onScan);
    onScanRef.current = onScan;

    useEffect(() => {
        if (!enabled) return undefined;
        const onKey = (e) => {
            if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
            if (e.key === 'Enter') {
                const code = buf.current;
                buf.current = '';
                if (code.length >= 4) onScanRef.current?.(code);
                return;
            }
            if (e.key.length === 1) {
                buf.current += e.key;
                clearTimeout(timer.current);
                timer.current = setTimeout(() => { buf.current = ''; }, 120);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            clearTimeout(timer.current);
        };
    }, [enabled]);
}
