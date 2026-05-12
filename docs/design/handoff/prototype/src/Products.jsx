// Productos de proveedores — tabla con filtros, precio calculado, modal vincular Odoo

const Products = () => {
  const [search, setSearch] = React.useState('');
  const [supplier, setSupplier] = React.useState('all');
  const [cat, setCat] = React.useState('all');
  const [available, setAvailable] = React.useState('all');
  const [company, setCompany] = React.useState('neggo');
  const [selected, setSelected] = React.useState(null);
  const [linked, setLinked] = React.useState(false);

  const filtered = PRODUCTS.filter(p => {
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.sku.toLowerCase().includes(search.toLowerCase())) return false;
    if (supplier !== 'all' && p.supplier !== supplier) return false;
    if (cat !== 'all' && p.cat !== cat) return false;
    if (available === 'yes' && !p.available) return false;
    if (available === 'no' && p.available) return false;
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Filters bar */}
      <Card padding={false} style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nombre o SKU…"
            leftIcon={<Icons.Search size={15} />}
            style={{ flex: '1 1 280px', minWidth: 200 }}
          />
          <Select value={supplier} onChange={setSupplier} placeholder="Proveedor"
            style={{ width: 160 }}
            options={[{ value: 'all', label: 'Todos los proveedores' }, ...SUPPLIERS.map(s => ({ value: s.name, label: s.name }))]}
          />
          <Select value={cat} onChange={setCat} placeholder="Categoría"
            style={{ width: 160 }}
            options={[{ value: 'all', label: 'Todas las categorías' }, ...CATEGORIES.map(c => ({ value: c, label: c }))]}
          />
          <Select value={available} onChange={setAvailable}
            style={{ width: 140 }}
            options={[
              { value: 'all', label: 'Todos' },
              { value: 'yes', label: 'Con stock' },
              { value: 'no', label: 'Sin stock' },
            ]}
          />
          <div style={{
            display: 'flex', background: 'var(--surface-2)',
            borderRadius: 'var(--radius-sm)', padding: 3,
            border: '1px solid var(--border)',
          }}>
            {['neggo', 'preventas'].map(c => (
              <button key={c} onClick={() => setCompany(c)} style={{
                padding: '0 14px', height: 32, borderRadius: 4,
                fontSize: 'var(--font-sm)', fontWeight: 500,
                background: company === c ? 'var(--surface)' : 'transparent',
                color: company === c ? 'var(--text)' : 'var(--text-muted)',
                boxShadow: company === c ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                textTransform: 'capitalize',
              }}>{c}</button>
            ))}
          </div>
        </div>
      </Card>

      {/* Result count */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px' }}>
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)' }}>
          <span className="num" style={{ color: 'var(--text)', fontWeight: 600 }}>{filtered.length}</span>
          {' '}productos · precio mostrado: <span style={{ color: 'var(--text)', fontWeight: 500, textTransform: 'capitalize' }}>{company}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" variant="ghost" leftIcon={<Icons.Refresh size={14} />}>Recalcular</Button>
          <Button size="sm" variant="secondary" leftIcon={<Icons.Doc size={14} />}>Exportar</Button>
        </div>
      </div>

      {/* Table */}
      <Card padding={false}>
        <div style={{ overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-sm)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Producto</th>
                <th style={th}>Proveedor</th>
                <th style={th}>Categoría</th>
                <th style={{ ...th, textAlign: 'right' }}>Precio prov.</th>
                <th style={{ ...th, textAlign: 'right' }}>Costo</th>
                <th style={{ ...th, textAlign: 'right' }}>Venta</th>
                <th style={{ ...th, textAlign: 'right' }}>Δ</th>
                <th style={{ ...th, width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id}
                  onClick={() => setSelected(p)}
                  style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <ProductThumb emoji={p.image} size={36} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }}>{p.name}</div>
                        <div className="mono" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-faint)', marginTop: 2 }}>{p.sku}</div>
                      </div>
                    </div>
                  </td>
                  <td style={td}>{p.supplier}</td>
                  <td style={td}><Badge tone="muted">{p.cat}</Badge></td>
                  <td style={{ ...td, textAlign: 'right' }} className="num">{fmtAR(p.raw)}</td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }} className="num">{fmtAR(p.cost)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600 }} className="num">{fmtAR(company === 'neggo' ? p.neggo : p.preventas)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {p.change === 0 ? (
                      <span style={{ color: 'var(--text-faint)' }}>—</span>
                    ) : (
                      <span className="num" style={{
                        color: p.change > 0 ? 'var(--danger)' : 'var(--success)', fontWeight: 500,
                      }}>{fmtPct(p.change)}</span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {p.available ? (
                      <Badge tone="success" dot>stock</Badge>
                    ) : (
                      <Badge tone="danger" dot>sin stock</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>
              No hay productos que coincidan con tu búsqueda.
            </div>
          )}
        </div>
      </Card>

      {/* Modal: detalle producto + vincular Odoo */}
      <Modal open={!!selected} onClose={() => { setSelected(null); setLinked(false); }}
        width={620}
        title={selected?.name}
        subtitle={selected ? `${selected.supplier} · ${selected.sku}` : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSelected(null)}>Cerrar</Button>
            {linked ? (
              <Button variant="primary" leftIcon={<Icons.Check size={14} />} onClick={() => setSelected(null)}>Listo</Button>
            ) : (
              <Button variant="primary" leftIcon={<Icons.Link size={14} />} onClick={() => setLinked(true)}>Vincular a Odoo</Button>
            )}
          </>
        }
      >
        {selected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <ProductThumb emoji={selected.image} size={64} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Categoría origen</div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>{selected.cat}</div>
                <Badge tone={selected.available ? 'success' : 'danger'} dot>
                  {selected.available ? 'En stock' : 'Sin stock'}
                </Badge>
              </div>
            </div>

            {/* Price calc */}
            <div>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 10 }}>Cálculo de precio</div>
              <div style={{
                background: 'var(--surface-2)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                padding: 14,
              }}>
                <PriceRow label="Precio proveedor" value={fmtAR(selected.raw)} />
                <PriceRow label="Descuento aplicado" value="−15.0%" muted />
                <PriceRow label="Costo final" value={fmtAR(selected.cost)} />
                <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
                <PriceRow label="Markup Neggo" value="+25.0%" muted />
                <PriceRow label="Precio venta Neggo" value={fmtAR(selected.neggo)} bold />
                <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
                <PriceRow label="Markup Preventas" value="+20.0% s/prov." muted />
                <PriceRow label="Precio venta Preventas" value={fmtAR(selected.preventas)} bold />
              </div>
            </div>

            {/* Vínculo Odoo */}
            <div>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 10 }}>
                Vínculo con Odoo {linked && <Badge tone="success" dot style={{ marginLeft: 8 }}>vinculado</Badge>}
              </div>
              {linked ? (
                <div style={{
                  border: '1px solid var(--success)',
                  background: 'var(--success-soft)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 14, display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <Icons.Check size={18} stroke="var(--success)" />
                  <div>
                    <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500 }}>Vinculado a Odoo Neggo</div>
                    <div className="mono" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                      ref. interna: NEG-{Math.floor(Math.random() * 90000) + 10000}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{
                  border: '1px dashed var(--border-strong)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 14, display: 'flex', alignItems: 'center', gap: 12,
                  color: 'var(--text-muted)',
                }}>
                  <Icons.Link size={16} />
                  <div style={{ fontSize: 'var(--font-sm)', flex: 1 }}>
                    Sin vínculo. Sugerencia: <span style={{ color: 'var(--text)', fontWeight: 500 }}>{selected.name}</span>
                    <span style={{ marginLeft: 6 }}><Badge tone="primary">95% match</Badge></span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

const th = {
  padding: '11px 16px',
  fontSize: 'var(--font-xs)', fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
};
const td = {
  padding: '12px 16px',
  color: 'var(--text)',
  whiteSpace: 'nowrap',
};

const PriceRow = ({ label, value, muted, bold }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 'var(--font-sm)' }}>
    <span style={{ color: muted ? 'var(--text-muted)' : 'var(--text)' }}>{label}</span>
    <span className="num" style={{ fontWeight: bold ? 600 : 500, color: muted ? 'var(--text-muted)' : 'var(--text)' }}>{value}</span>
  </div>
);

window.Products = Products;
