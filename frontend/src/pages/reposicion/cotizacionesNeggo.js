// Cotizaciones «Pendiente» de Neggo dentro de la reposición (nota 149).
// Lógica pura sobre la respuesta de GET /reposicion/cotizaciones: qué espera cada cliente,
// qué falta pedir por proveedor y el resumen del bloque de arriba de Pendientes.
// Preventas queda afuera: la reposición es solo de Neggo.

import { claveNombre } from './pedidoDestino.js';

export function productosNeggo(data) {
    return (data?.productos || []).filter(p => p.company === 'neggo');
}

export function cotizacionesNeggo(data) {
    return (data?.cotizaciones || []).filter(c => c.company === 'neggo');
}

/** odoo_id → cotizaciones de clientes que esperan ese producto ({ name, partner_name, qty }). */
export function esperasPorProducto(data) {
    const mapa = new Map();
    for (const p of productosNeggo(data)) {
        if (p.llego) continue;
        const esperan = (p.cotizaciones || []).filter(c => !c.llego);
        if (esperan.length) mapa.set(p.odoo_id, esperan);
    }
    return mapa;
}

/** Nombre corto del cliente: «Soledad Linares» → «Soledad L.» */
export function clienteCorto(nombre) {
    const partes = String(nombre || '').replace(/^[^,]*,\s*/, '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '';
    if (partes.length === 1) return partes[0];
    return `${partes[0]} ${partes[partes.length - 1][0].toUpperCase()}.`;
}

/** «Para S04383 · Soledad L. × 2» y, si hay más, « +1». */
export function textoEspera(esperas) {
    if (!esperas || !esperas.length) return '';
    const [c] = esperas;
    const cliente = clienteCorto(c.partner_name);
    const base = `Para ${c.name}${cliente ? ` · ${cliente}` : ''} × ${Math.round(Number(c.qty) || 0)}`;
    return esperas.length > 1 ? `${base} +${esperas.length - 1}` : base;
}

/** Productos de Neggo que todavía no se pidieron, de un proveedor (o todos sin proveedor). */
export function reponiblesDe(data, proveedor = null) {
    const key = proveedor == null ? null : claveNombre(proveedor);
    return productosNeggo(data).filter(p => p.puede_reponer && (key == null || claveNombre(p.vendor_name) === key));
}

/** Cotizaciones de Neggo con todo lo que faltaba ya ingresado: hay que avisarle al cliente. */
export function cotizacionesCompletas(data) {
    return cotizacionesNeggo(data).filter(c => c.productos.length > 0 && c.n_llegados === c.productos.length);
}

/**
 * Números del bloque «Clientes esperando mercadería».
 * proveedores: los que más productos sin pedir tienen, más primero.
 */
export function resumenBloque(data, topProveedores = 4) {
    const productos = productosNeggo(data);
    const sinPedir = productos.filter(p => p.puede_reponer);
    const porProveedor = new Map();
    for (const p of sinPedir) porProveedor.set(p.vendor_name, (porProveedor.get(p.vendor_name) || 0) + 1);
    const proveedores = [...porProveedor.entries()]
        .map(([nombre, n]) => ({ nombre, n }))
        .sort((a, b) => b.n - a.n || a.nombre.localeCompare(b.nombre, 'es'));
    return {
        cotizaciones: cotizacionesNeggo(data).length,
        productos: productos.length,
        sinPedir: sinPedir.length,
        enCola: productos.filter(p => p.estado_cola === 'pendiente').length,
        encargados: productos.filter(p => p.estado_cola === 'encargado').length,
        llegaron: productos.filter(p => p.llego).length,
        completas: cotizacionesCompletas(data).length,
        proveedores: proveedores.slice(0, topProveedores),
        otrosProveedores: Math.max(0, proveedores.length - topProveedores),
    };
}
