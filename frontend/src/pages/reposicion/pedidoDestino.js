// A qué proveedor va cada pendiente al armar el pedido.
// Si hay una oferta vinculada más barata que la del principal, entra ahí.
// Si no, queda en el proveedor de Odoo. Sin ofertas confirmadas, no está vinculado.

export function claveNombre(nombre) {
    return String(nombre || '').trim().toLocaleLowerCase('es');
}

export function estaVinculado(it) {
    return Array.isArray(it.ofertas?.ofertas) && it.ofertas.ofertas.length > 0;
}

/** Oferta disponible más barata y de otro proveedor. Null si no conviene salir del principal. */
export function ofertaMasBarata(it) {
    const me = it.ofertas?.mas_economico;
    if (!it.ofertas?.conviene || !me || me.disponible === false || !(Number(me.precio) > 0)) return null;
    return me;
}

export function proveedorPrincipal(it) {
    const nombre = String(it.vendor_name || '').trim();
    return nombre || 'Sin proveedor';
}

export function ofertaElegida(it, lado) {
    const barata = ofertaMasBarata(it);
    if (barata && lado !== 'principal') return barata;
    const principal = (it.ofertas?.ofertas || []).find(o => o.es_principal && o.disponible !== false && Number(o.precio) > 0);
    return principal || null;
}

export function destinoDe(it, lado) {
    const elegida = ofertaElegida(it, lado);
    if (elegida && ofertaMasBarata(it) && lado !== 'principal') {
        return elegida.proveedor_odoo || elegida.proveedor;
    }
    return proveedorPrincipal(it);
}

export function proveedoresDelPedido(items, lados = {}) {
    const grupos = new Map();
    const asegurar = (nombre) => {
        const key = nombre || 'Sin proveedor';
        if (!grupos.has(key)) grupos.set(key, { nombre: key, n: 0, sin: 0 });
        return grupos.get(key);
    };
    for (const it of items) {
        const destino = destinoDe(it, lados[it.id]);
        const g = asegurar(destino);
        g.n += 1;
        if (!estaVinculado(it)) g.sin += 1;
        if (ofertaMasBarata(it)) asegurar(proveedorPrincipal(it));
    }
    return [...grupos.values()].sort((a, b) => b.n - a.n || a.nombre.localeCompare(b.nombre, 'es'));
}

/** Lo que sale en el PDF de la lista: todo lo del proveedor con la cantidad en pantalla, sin los que están en cero. */
export function listaDelProveedor(items, proveedor, lados = {}, qtys = {}) {
    return items
        .filter(it => destinoDe(it, lados[it.id]) === proveedor)
        .map(it => ({ ...it, qty: Number(qtys[it.id]) }))
        .filter(it => it.qty > 0)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
}

/** Una lista por proveedor; los que se quedaron sin nada para pedir no generan PDF. */
export function listasParaPdf(items, lados = {}, qtys = {}) {
    return proveedoresDelPedido(items, lados)
        .map(g => ({ proveedor: g.nombre, items: listaDelProveedor(items, g.nombre, lados, qtys) }))
        .filter(l => l.items.length > 0);
}

export function filtrarSolapa(items, solapa) {
    if (solapa === 'sin') return items.filter(it => !estaVinculado(it));
    if (solapa === 'vinculados') return items.filter(it => estaVinculado(it));
    return items;
}

export function accesoDe(nombre, accesos) {
    const key = claveNombre(nombre);
    const hit = (accesos || []).find(a => claveNombre(a.name) === key || claveNombre(a.odoo_vendor_name) === key);
    if (!hit?.website_url) return { tipo: 'pdf', sitio: null };
    return { tipo: hit.pide_clave ? 'clave' : 'abierta', sitio: hit.website_url };
}

/**
 * Productos de órdenes sin revisar, de este proveedor, que todavía no están en la cola.
 * Suma la cantidad vendida si el mismo producto está en más de un pedido.
 */
export function recomendarDePedidos(ordenes, proveedor, odooIdsEnCola) {
    const enCola = new Set(odooIdsEnCola || []);
    const key = claveNombre(proveedor);
    const mapa = new Map();
    for (const orden of ordenes || []) {
        for (const p of orden.productos || []) {
            if (!p.en_cache || p.es_liquidar || p.en_cola) continue;
            if (p.odoo_id == null || enCola.has(p.odoo_id)) continue;
            if (claveNombre(p.vendor_name) !== key) continue;
            const prev = mapa.get(p.odoo_id);
            const qty = Number(p.qty) || 0;
            if (!prev) {
                mapa.set(p.odoo_id, {
                    odoo_id: p.odoo_id,
                    name: p.name || p.nombre_odoo,
                    internal_ref: p.internal_ref || null,
                    image_url: p.image_url || null,
                    vendor_name: p.vendor_name,
                    qty,
                    pedidos: orden.name ? [orden.name] : [],
                });
            } else {
                prev.qty += qty;
                if (orden.name && !prev.pedidos.includes(orden.name)) prev.pedidos.push(orden.name);
            }
        }
    }
    return [...mapa.values()].sort((a, b) => b.qty - a.qty || String(a.name).localeCompare(String(b.name), 'es'));
}
