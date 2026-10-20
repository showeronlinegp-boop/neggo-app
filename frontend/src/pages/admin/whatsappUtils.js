// Helpers compartidos por la pantalla de WhatsApp.

const ART = 'America/Argentina/Buenos_Aires';

export function defaultSchedule() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
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
