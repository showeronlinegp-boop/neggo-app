-- El estado de armado/control sigue los envíos de Odoo, no se esconde el pedido.
-- Recolectar+entrega done (o factura/POS) = controlado. Un envío done = para controlar.
UPDATE pedido_envios
   SET estado = 'saldado',
       saldado_at = COALESCE(saldado_at, NOW()),
       updated_at = NOW()
 WHERE estado NOT IN ('cancelado', 'saldado')
   AND (
        COALESCE(odoo_picking_done_count, 0) >= 2
     OR COALESCE(odoo_invoice_count, 0) > 0
     OR COALESCE(odoo_pos_count, 0) > 0
     OR COALESCE(invoice_status, '') = 'invoiced'
   );

UPDATE pedido_envios
   SET estado = 'armado',
       updated_at = NOW()
 WHERE estado IN ('pendiente', 'armando')
   AND COALESCE(odoo_picking_done_count, 0) = 1;
