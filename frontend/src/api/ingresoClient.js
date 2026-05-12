import api from './client';

/**
 * API wrapper para módulo de ingreso de mercadería
 * Reutiliza el cliente JWT autenticado existente
 */
export const ingresoAPI = {
  /**
   * Upload CSV: parse -> match -> validate -> create preview
   * @returns { success, data: { ingreso_id, preview, parse_errors } }
   */
  uploadCSV: (file, supplierId, comprobanteTipo, comprobantNumero) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('supplier_id', supplierId || '');
    formData.append('comprobante_tipo', comprobanteTipo);
    formData.append('comprobante_numero', comprobantNumero);
    return api.post('/ingreso/upload', formData);
  },

  /**
   * Get preview completo del ingreso
   * @returns { success, data: { ingreso, items, summary } }
   */
  getPreview: (ingresoId) => api.get(`/ingreso/${ingresoId}`),

  rematch: (ingresoId) => api.post(`/ingreso/${ingresoId}/rematch`, {}),

  /**
   * Update item: cambiar match o rechazar
   * @param {object} data — { odoo_product_id?, estado_item?, motivo_rechazo? }
   */
  updateItem: (ingresoId, itemId, data) =>
    api.patch(`/ingreso/${ingresoId}/items/${itemId}`, data),

  /**
   * Confirm ingreso: aplicar cambios a Odoo
   * @param {object} body — { odoo_partner_id? }
   * @returns { success, data: { updated_products_count, price_changes, odoo_purchase_order_id } }
   */
  confirmIngreso: (ingresoId, body = {}) =>
    api.post(`/ingreso/${ingresoId}/confirm`, body),

  /**
   * List ingresos with filters
   * @param {object} filters — { supplier_id?, estado?, desde?, hasta?, limit?, offset? }
   */
  listIngresos: (filters = {}) =>
    api.get('/ingreso', filters),

  /**
   * Eliminar ingreso pendiente
   */
  deleteIngreso: (ingresoId) => api.del(`/ingreso/${ingresoId}`),

  /**
   * Items del ingreso vs cotizaciones locales de preventas (por supplier_product_id)
   */
  getPreventaItems: (ingresoId) => api.get(`/ingreso/${ingresoId}/preventa-items`),

  /**
   * Compara ítems del ingreso con cotizaciones abiertas en Odoo Preventas (en vivo)
   */
  getPreventaOdooMatch: (ingresoId) => api.get(`/ingreso/${ingresoId}/preventa-odoo-match`),

  /**
   * Sincroniza precios actuales de Odoo → cache local + precio_odoo_anterior en ingreso_items
   */
  syncOdooPrices: (ingresoId) => api.post(`/ingreso/${ingresoId}/sync-odoo-prices`, {}),

  /**
   * Fusiona ítems con el mismo código en un solo registro sumando cantidades y unidades recibidas
   */
  mergeDuplicateItems: (ingresoId) => api.post(`/ingreso/${ingresoId}/merge-duplicate-items`, {}),

  /**
   * Asigna el proveedor del comprobante como supplierinfo en Odoo Neggo para el producto del ítem
   * @returns { success, data: { vendor_name, already_existed } }
   */
  assignSupplier: (ingresoId, itemId) =>
    api.post(`/ingreso/${ingresoId}/items/${itemId}/assign-supplier`, {}),

  /**
   * Busca en Odoo una categoría web cuyo nombre coincida con la categoría interna del producto
   * y la asigna. Evita el error de IDs distintos entre product.category y product.public.category.
   * @returns { success, data: { web_categ_id, web_categ_name } }
   */
  assignWebCategFromProduct: (ingresoId, itemId) =>
    api.post(`/ingreso/${ingresoId}/items/${itemId}/assign-web-categ-from-product`, {}),
};
