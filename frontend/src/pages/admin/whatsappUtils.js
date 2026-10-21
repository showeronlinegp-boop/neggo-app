// Helpers compartidos por la pantalla de WhatsApp.

const ART = 'America/Argentina/Buenos_Aires';

// Por defecto, el momento actual en hora de Argentina (AAAA-MM-DDTHH:mm, lo que espera el backend)
export function defaultSchedule() {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: ART,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(new Date()).map((x) => [x.type, x.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function fmtWhen(iso, { seconds = false } = {}) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-AR', {
        timeZone: ART,
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        ...(seconds ? { second: '2-digit' } : {}),
    });
}

// "2 d 03:04:05", "03:04:05" o "04:05"
export function fmtCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p = (n) => String(n).padStart(2, '0');
    const clock = h || d ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
    return d ? `${d} d ${clock}` : clock;
}

export function odooImageUrl(company, templateId) {
    return templateId ? `/api/products/odoo-image/${company}/${templateId}` : null;
}
