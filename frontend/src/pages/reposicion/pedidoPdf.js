// Pedido al proveedor en PDF, con el mismo generador que Preventas (Chrome headless en el backend).
// items: [{ name, internal_ref, barcode, image_url, standard_price, qty, cotizaciones? }]
// cotizaciones (opcional): [{ name, qty }] — salen debajo del producto en el PDF.
export async function descargarPedidoPDF(vendor, items, { prefijo = 'reposicion' } = {}) {
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
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = vendor.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    a.href = url;
    a.download = `${prefijo}-${safe}-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
}
