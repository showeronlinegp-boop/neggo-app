// A qué proveedor va cada pendiente al armar el pedido.
// Si hay una oferta vinculada más barata que la del principal, entra ahí.
// Si no, queda en el proveedor de Odoo. Sin ofertas confirmadas, no está vinculado.
// Desde la nota 187 se puede mandar a cualquier proveedor vinculado o repartir la cantidad.

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

/** Oferta del proveedor principal, si tiene precio. */
function ofertaPrincipal(it) {
    const ofs = (it.ofertas?.ofertas || []).filter(o => o.es_principal && Number(o.precio) > 0);
    return ofs.find(o => o.disponible !== false) || ofs[0] || null;
}

/** El proveedor principal tiene alguna oferta vinculada (nota 218). */
export function principalConOferta(it) {
    return (it.ofertas?.ofertas || []).some(o => o.es_principal);
}

/**
 * Mejor oferta de otro proveedor cuando el principal no tiene ninguna vinculada (nota 218).
 * Ya vienen ordenadas: disponibles primero y de menor a mayor precio.
 */
export function ofertaSinPrincipal(it) {
    if (!estaVinculado(it) || principalConOferta(it)) return null;
    const principal = claveNombre(proveedorPrincipal(it));
    return it.ofertas.ofertas.find(o =>
        Number(o.precio) > 0 && claveNombre(o.proveedor_odoo || o.proveedor) !== principal) || null;
}

/**
 * A quién se le puede pedir el producto (nota 187): el principal de Odoo y cada proveedor
 * con una oferta vinculada, aunque no sea más barato. Uno por proveedor, con su mejor oferta.
 * sin_oferta: el principal no tiene oferta vinculada pero otros sí (nota 218).
 * @returns {Array<{ nombre, precio, url, disponible, es_principal, mas_barato, sin_oferta }>}
 */
export function candidatosDe(it) {
    const nombrePrincipal = proveedorPrincipal(it);
    const barata = ofertaMasBarata(it);
    const op = ofertaPrincipal(it);
    const principal = {
        nombre: nombrePrincipal,
        precio: op ? Number(op.precio) : (Number(it.standard_price) > 0 ? Number(it.standard_price) : null),
        url: op?.url || null,
        disponible: op ? op.disponible !== false : true,
        es_principal: true,
        mas_barato: false,
        sin_oferta: estaVinculado(it) && !principalConOferta(it),
    };
    const lista = [principal];
    const vistos = new Set([claveNombre(nombrePrincipal)]);
    // Ya vienen ordenadas: disponibles primero y de menor a mayor precio
    for (const o of it.ofertas?.ofertas || []) {
        if (!(Number(o.precio) > 0)) continue;
        const nombre = o.proveedor_odoo || o.proveedor;
        if (vistos.has(claveNombre(nombre))) continue;
        vistos.add(claveNombre(nombre));
        lista.push({
            nombre,
            precio: Number(o.precio),
            url: o.url || null,
            disponible: o.disponible !== false,
            es_principal: false,
            mas_barato: !!barata && claveNombre(barata.proveedor_odoo || barata.proveedor) === claveNombre(nombre),
            sin_oferta: false,
        });
    }
    return lista;
}

/**
 * Sin tocar nada: al más económico si conviene; si el principal no tiene oferta vinculada,
 * al mejor que sí la tenga (nota 218); si no, al principal.
 */
export function destinoPorDefecto(it) {
    const elegida = ofertaMasBarata(it) || ofertaSinPrincipal(it);
    return elegida ? (elegida.proveedor_odoo || elegida.proveedor) : proveedorPrincipal(it);
}

/**
 * En qué proveedores queda el producto y cuánto va a cada uno.
 * asignacion: undefined (por defecto) o [{ destino, qty }]; con un solo destino va toda la cantidad.
 */
export function partesDe(it, asignacion, qtyTotal) {
    const total = Number(qtyTotal);
    if (!Array.isArray(asignacion) || asignacion.length === 0) {
        return [{ destino: destinoPorDefecto(it), qty: total }];
    }
    if (asignacion.length === 1) return [{ destino: asignacion[0].destino, qty: total }];
    return asignacion.map(p => ({ destino: p.destino, qty: Number(p.qty) || 0 }));
}

export function destinosDe(it, asignacion) {
    return [...new Set(partesDe(it, asignacion, 0).map(p => p.destino))];
}

/** Proveedor del producto (el primero, si está repartido). */
export function destinoDe(it, asignacion) {
    return destinosDe(it, asignacion)[0];
}

export function vaA(it, proveedor, asignacion) {
    return destinosDe(it, asignacion).includes(proveedor);
}

/** Cantidad que se le pide a ese proveedor. */
export function qtyEn(it, proveedor, asignacion, qtyTotal) {
    return partesDe(it, asignacion, qtyTotal)
        .filter(p => p.destino === proveedor)
        .reduce((s, p) => s + (Number.isFinite(p.qty) ? p.qty : 0), 0);
}

export function estaRepartido(asignacion) {
    return Array.isArray(asignacion) && new Set(asignacion.map(p => p.destino)).size > 1;
}

/**
 * Normaliza lo que se cargó en «Repartir»: saca los que quedaron en cero.
 * Si queda uno solo, va todo ahí. Devuelve { asignacion, total } o null si no quedó nada.
 */
export function armarReparto(cantidades) {
    const partes = [];
    for (const [destino, q] of Object.entries(cantidades || {})) {
        const n = Number(q);
        if (Number.isInteger(n) && n > 0) partes.push({ destino, qty: n });
    }
    if (partes.length === 0) return null;
    const total = partes.reduce((s, p) => s + p.qty, 0);
    if (partes.length === 1) return { asignacion: [{ destino: partes[0].destino, qty: null }], total };
    return { asignacion: partes, total };
}

export function proveedoresDelPedido(items, asignaciones = {}) {
    const grupos = new Map();
    const asegurar = (nombre) => {
        const key = nombre || 'Sin proveedor';
        if (!grupos.has(key)) grupos.set(key, { nombre: key, n: 0, sin: 0 });
        return grupos.get(key);
    };
    for (const it of items) {
        for (const destino of destinosDe(it, asignaciones[it.id])) {
            const g = asegurar(destino);
            g.n += 1;
            if (!estaVinculado(it)) g.sin += 1;
        }
        if (ofertaMasBarata(it) || ofertaSinPrincipal(it)) asegurar(proveedorPrincipal(it));
    }
    return [...grupos.values()].sort((a, b) => b.n - a.n || a.nombre.localeCompare(b.nombre, 'es'));
}

/** Lo que sale en el PDF de la lista: todo lo del proveedor con la cantidad en pantalla, sin los que están en cero. */
export function listaDelProveedor(items, proveedor, asignaciones = {}, qtys = {}) {
    return items
        .filter(it => vaA(it, proveedor, asignaciones[it.id]))
        .map(it => ({ ...it, qty: qtyEn(it, proveedor, asignaciones[it.id], qtys[it.id]) }))
        .filter(it => it.qty > 0)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
}

/** Una lista por proveedor; los que se quedaron sin nada para pedir no generan PDF. */
export function listasParaPdf(items, asignaciones = {}, qtys = {}) {
    return proveedoresDelPedido(items, asignaciones)
        .map(g => ({ proveedor: g.nombre, items: listaDelProveedor(items, g.nombre, asignaciones, qtys) }))
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
 * Link de un producto en la web del proveedor (nota 192).
 * Solo va al producto si hay una oferta vinculada de ese proveedor con su URL; si no, abre la web
 * general y lo dice. Con clave, el link al producto anda una vez que se ingresó en esa web.
 * @param {{ url?: string|null }|null} candidato — el de este proveedor (candidatosDe)
 * @param {{ tipo: string, sitio: string|null }} acceso — accesoDe(...)
 * @param {string} proveedor — nombre para los textos de ayuda
 * @returns {{ href: string, alProducto: boolean, texto: string, ayuda: string }|null}
 */
export function linkDelProducto(candidato, acceso, proveedor) {
    const url = candidato?.url || null;
    const sitio = acceso?.sitio || null;
    const quien = proveedor || 'el proveedor';
    if (url) {
        if (acceso?.tipo === 'clave') {
            return {
                href: url, alProducto: true, texto: 'Abrir producto (pide clave)',
                ayuda: `Si ${quien} te pide la clave, ingresala y volvé a tocar este link: ahí va directo al producto.`,
            };
        }
        return {
            href: url, alProducto: true,
            texto: acceso?.tipo === 'pdf' ? 'Abrir ficha' : 'Ver en el catálogo',
            ayuda: 'Abre el producto en la web del proveedor.',
        };
    }
    if (!sitio) return null;
    return {
        href: sitio, alProducto: false,
        texto: acceso?.tipo === 'clave' ? 'Solo la web (pide clave)' : 'Solo la web',
        ayuda: `No está vinculado a una oferta de ${quien}: se abre la web general. Tocá «Vínculos» para sumarla y que el link vaya al producto.`,
    };
}

function sinAcentos(texto) {
    return String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');
}

/** Buscador de Armar pedido (nota 188): todas las palabras tienen que aparecer en el nombre, el código o el código de barras. */
export function coincideBusqueda(it, texto) {
    const palabras = sinAcentos(texto).split(/\s+/).filter(Boolean);
    if (!palabras.length) return true;
    const donde = sinAcentos([it.name, it.internal_ref, it.barcode].filter(Boolean).join(' '));
    return palabras.every(p => donde.includes(p));
}

/** Cuántos productos que coinciden con la búsqueda van a cada proveedor (uno repartido cuenta en cada uno). */
export function coincidenciasPorProveedor(items, texto, asignaciones = {}) {
    const cuenta = new Map();
    for (const it of items) {
        if (!coincideBusqueda(it, texto)) continue;
        for (const destino of destinosDe(it, asignaciones[it.id])) {
            cuenta.set(destino, (cuenta.get(destino) || 0) + 1);
        }
    }
    return cuenta;
}
