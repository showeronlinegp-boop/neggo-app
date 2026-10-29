-- Tabla maestra (nota 107): revisión de los vínculos hechos a mano al confirmar un ingreso.
-- Solo aditiva. Un renglón manual (producto de Odoo u oferta elegidos a mano) entra a la tabla
-- maestra solo si se tildó en la revisión; lo revisado no se vuelve a marcar en ingresos futuros
-- (mismo proveedor + mismo código de factura + mismo producto de Odoo).
ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS vinculo_revisado_at TIMESTAMP;
ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS vinculo_revisado_por INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ii_vinculo_revisado ON ingreso_items(odoo_product_id)
    WHERE vinculo_revisado_at IS NOT NULL;
