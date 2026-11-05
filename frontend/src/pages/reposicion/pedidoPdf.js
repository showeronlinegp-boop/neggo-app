import { buildZip } from '../admin/zipStore.js';

// Pedido al proveedor en PDF, con el mismo generador que Preventas (Chrome headless en el backend).
// items: [{ name, internal_ref, barcode, image_url, standard_price, qty, cotizaciones? }]
// cotizaciones (opcional): [{ name, qty }] — salen debajo del producto en el PDF.
async function generarPedidoPDF(vendor, items) {
    const products = items.map(it => ({
        product_name: it.name,
        external_id:  it.internal_ref || it.barcode || null,
        unit_cost:    Number(it.standard_price) > 0 ? Number(it.standard_price) : null,
        total_qty:    it.qty,
        image_url:    it.image_url,
        quotations:   (it.cotizaciones || []).map(c => ({ quotation_name: c.name, qty: c.qty })),
    }));
    const hasCost = products.some(p => p.unit_cost != null);
    const totalCost = products.reduce((s, p) => p.unit_cost != null ? s + p.unit_cost * p.total_qty : s, 0);
    const token = localStorage.getItem('neggo_token');
    const res = await fetch('/api/preventas/odoo-quotations/pdf', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            supplier_name: vendor,
            products,
            total_cost: hasCost ? Math.round(totalCost * 100) / 100 : null,
            total_qty:  products.reduce((s, p) => s + p.total_qty, 0),
        }),
    });
    if (!res.ok) {
        let message = 'No se pudo generar el PDF';
        try {
            const body = await res.json();
            if (body?.error) message = body.error;
        } catch { /* la respuesta no era JSON */ }
        throw new Error(message);
    }
    return res.blob();
}

function guardar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(url);
}

const hoy = () => new Date().toISOString().slice(0, 10);

export async function descargarPedidoPDF(vendor, items, { prefijo = 'reposicion' } = {}) {
    const blob = await generarPedidoPDF(vendor, items);
    const safe = vendor.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    guardar(blob, `${prefijo}-${safe}-${hoy()}.pdf`);
}

// Nombre legible adentro del .zip. Windows no distingue mayúsculas: dos proveedores
// que quedarían iguales se separan con un número para que ninguno pise al otro.
export function nombreEnZip(proveedor, usados) {
    const base = String(proveedor).replace(/[\\/:*?"<>|]/g, '-').trim() || 'Sin nombre';
    let nombre = `${base}.pdf`;
    for (let n = 2; usados.has(nombre.toLowerCase()); n++) nombre = `${base} (${n}).pdf`;
    usados.add(nombre.toLowerCase());
    return nombre;
}

// Un PDF por proveedor, todos en un .zip. Se generan de a uno: cada PDF abre Chrome
// y pide las fotos a Odoo, que es producción. Si uno falla, siguen los demás.
// listas: [{ proveedor, items }] · onAvance(n, total)
export async function descargarListasPDF(listas, { onAvance } = {}) {
    const files = [];
    const fallaron = [];
    const usados = new Set();
    for (let i = 0; i < listas.length; i++) {
        const { proveedor, items } = listas[i];
        onAvance?.(i + 1, listas.length);
        try {
            const blob = await generarPedidoPDF(proveedor, items);
            files.push({ name: nombreEnZip(proveedor, usados), data: new Uint8Array(await blob.arrayBuffer()) });
        } catch {
            fallaron.push(proveedor);
        }
    }
    if (!files.length) throw new Error('No se pudo generar ninguna lista');
    guardar(new Blob([buildZip(files)], { type: 'application/zip' }), `listas-proveedores-${hoy()}.zip`);
    return { descargadas: files.length, fallaron };
}
