// Preventas — pedidos de cliente. Lista + flow de creación con catálogo.

const Preventas = () => {
  const [view, setView] = React.useState('list');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [orders, setOrders] = React.useState(CLIENT_ORDERS);

  if (view === 'new') return <NewOrder onCancel={() => setView('list')} onSave={(o) => { setOrders([o, ...orders]); setView('list'); }} />;

  const filtered = orders.filter(o => statusFilter === 'all' || o.status === statusFilter);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card padding={false} style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input placeholder="Buscar cliente, número de pedido…"
            leftIcon={<Icons.Search size={15} />}
            style={{ flex: '1 1 280px' }}
          />
          <Select value={statusFilter} onChange={setStatusFilter}
            style={{ width: 180 }}
            options={[
              { value: 'all', label: 'Todos los estados' },
              ...Object.entries(STATUS_LABELS).map(([k, v]) => ({ value: k, label: v.label })),
            ]}
          />
          <Button variant="primary" leftIcon={<Icons.Plus size={15} />} onClick={() => setView('new')}>
            Nuevo pedido
          </Button>
        </div>
      </Card>

      <Card padding={false}>
        <div style={{ overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-sm)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Pedido</th>
                <th style={th}>Cliente</th>
                <th style={{ ...th, textAlign: 'right' }}>Items</th>
                <th style={{ ...th, textAlign: 'right' }}>Total</th>
                <th style={th}>Estado</th>
                <th style={th}>Creado</th>
                <th style={{ ...th, width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(o => {
                const s = STATUS_LABELS[o.status];
                return (
                  <tr key={o.id} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={td}><span className="mono" style={{ fontWeight: 600 }}>{o.id}</span></td>
                    <td style={td}>
                      <div style={{ fontWeight: 500 }}>{o.client}</div>
                      <div className="mono" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-faint)', marginTop: 2 }}>{o.phone}</div>
                    </td>
                    <td style={{ ...td, textAlign: 'right' }} className="num">{o.items}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600 }} className="num">{fmtAR(o.total)}</td>
                    <td style={td}><Badge tone={s.tone} dot>{s.label}</Badge></td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{o.when}</td>
                    <td style={td}>
                      <button style={{
                        width: 28, height: 28, borderRadius: 6,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'var(--text-muted)',
                      }}><Icons.More size={15} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

const NewOrder = ({ onCancel, onSave }) => {
  const [client, setClient] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [items, setItems] = React.useState([]);

  const filtered = PRODUCTS.filter(p =>
    p.available && (!search || p.name.toLowerCase().includes(search.toLowerCase()))
  );

  const addItem = (p) => {
    setItems(prev => {
      const existing = prev.find(i => i.id === p.id);
      if (existing) return prev.map(i => i.id === p.id ? { ...i, qty: i.qty + 1 } : i);
      return [...prev, { ...p, qty: 1 }];
    });
  };

  const updateQty = (id, qty) => {
    if (qty <= 0) setItems(prev => prev.filter(i => i.id !== id));
    else setItems(prev => prev.map(i => i.id === id ? { ...i, qty } : i));
  };

  const total = items.reduce((s, i) => s + i.preventas * i.qty, 0);

  const save = () => {
    onSave({
      id: 'P-' + Math.floor(Math.random() * 9000 + 2419),
      client: client || 'Sin nombre',
      phone: phone || '—',
      items: items.reduce((s, i) => s + i.qty, 0),
      total: Math.round(total),
      status: 'pendiente',
      when: 'recién',
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Step header */}
      <Card padding={false} style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <Button variant="ghost" size="sm" onClick={onCancel} leftIcon={<Icons.X size={14} />}>Cancelar</Button>
        <div style={{ height: 20, width: 1, background: 'var(--border)' }} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 18 }}>
          <Step n={1} label="Datos del cliente" active />
          <StepConnector />
          <Step n={2} label="Productos" active={items.length > 0} />
          <StepConnector />
          <Step n={3} label="Confirmar" active={items.length > 0 && client} />
        </div>
        <Button variant="primary" disabled={!client || items.length === 0} onClick={save}
          rightIcon={<Icons.Check size={14} />}
          style={{ opacity: (!client || items.length === 0) ? 0.5 : 1 }}>
          Guardar pedido
        </Button>
      </Card>

      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 14,
      }} className="po-grid">
        {/* Left: cliente + catálogo */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card>
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 12 }}>Cliente</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 10 }}>
              <Input placeholder="Nombre del cliente" value={client} onChange={e => setClient(e.target.value)}
                leftIcon={<Icons.Users size={15} />} />
              <Input placeholder="Teléfono" value={phone} onChange={e => setPhone(e.target.value)} />
            </div>
          </Card>

          <Card padding={false}>
            <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
              <Input placeholder="Buscar productos…" value={search} onChange={e => setSearch(e.target.value)}
                leftIcon={<Icons.Search size={15} />} />
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 10, padding: 14,
              maxHeight: 540, overflow: 'auto',
            }}>
              {filtered.map(p => {
                const inCart = items.find(i => i.id === p.id);
                return (
                  <div key={p.id}
                    onClick={() => addItem(p)}
                    style={{
                      border: '1px solid ' + (inCart ? 'var(--primary)' : 'var(--border)'),
                      background: inCart ? 'var(--primary-soft)' : 'var(--surface)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 12, cursor: 'pointer',
                      transition: 'all 120ms',
                      display: 'flex', flexDirection: 'column', gap: 8,
                      position: 'relative',
                    }}>
                    {inCart && (
                      <div style={{
                        position: 'absolute', top: 8, right: 8,
                        background: 'var(--primary)', color: '#fff',
                        width: 22, height: 22, borderRadius: 999,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 600,
                      }}>{inCart.qty}</div>
                    )}
                    <ProductThumb emoji={p.image} size={48} />
                    <div style={{
                      fontSize: 'var(--font-xs)', fontWeight: 500, lineHeight: 1.3,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                      minHeight: 32,
                    }}>{p.name}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span className="num" style={{ fontSize: 14, fontWeight: 600 }}>{fmtAR(p.preventas)}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{p.supplier}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* Right: cart */}
        <Card padding={false} style={{ position: 'sticky', top: 20, alignSelf: 'flex-start' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>Pedido</div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
              {items.length === 0 ? 'Sin productos' : `${items.length} producto${items.length === 1 ? '' : 's'} · ${items.reduce((s, i) => s + i.qty, 0)} unidades`}
            </div>
          </div>

          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 999,
                  background: 'var(--surface-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 10px', color: 'var(--text-faint)',
                }}><Icons.Cart size={18} /></div>
                Tocá un producto del catálogo para agregarlo.
              </div>
            ) : items.map(i => (
              <div key={i.id} style={{
                padding: '10px 16px', display: 'flex', gap: 10, alignItems: 'center',
                borderBottom: '1px solid var(--border)',
              }}>
                <ProductThumb emoji={i.image} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 'var(--font-xs)', fontWeight: 500, lineHeight: 1.3,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{i.name}</div>
                  <div className="num" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                    {fmtAR(i.preventas)} c/u
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
                  <button onClick={() => updateQty(i.id, i.qty - 1)} style={qtyBtn}>−</button>
                  <span className="num" style={{ minWidth: 22, textAlign: 'center', fontSize: 'var(--font-sm)', fontWeight: 600 }}>{i.qty}</span>
                  <button onClick={() => updateQty(i.id, i.qty + 1)} style={qtyBtn}>+</button>
                </div>
              </div>
            ))}
          </div>

          <div style={{
            padding: '14px 16px', borderTop: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-sm)', color: 'var(--text-muted)' }}>
              <span>Subtotal</span>
              <span className="num">{fmtAR(total)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 16, fontWeight: 600 }}>
              <span>Total estimado</span>
              <span className="num">{fmtAR(total)}</span>
            </div>
          </div>
        </Card>
      </div>

      <style>{`
        @media (max-width: 980px) {
          .po-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
};

const Step = ({ n, label, active }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <div style={{
      width: 22, height: 22, borderRadius: 999,
      background: active ? 'var(--primary)' : 'var(--surface-2)',
      color: active ? '#fff' : 'var(--text-muted)',
      fontSize: 11, fontWeight: 600,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: active ? 'none' : '1px solid var(--border-strong)',
    }}>{n}</div>
    <span style={{ fontSize: 'var(--font-sm)', fontWeight: 500, color: active ? 'var(--text)' : 'var(--text-muted)' }}>{label}</span>
  </div>
);

const StepConnector = () => <div style={{ height: 1, flex: 1, background: 'var(--border)', maxWidth: 40 }} />;

const qtyBtn = {
  width: 26, height: 26,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 14, fontWeight: 600, color: 'var(--text-muted)',
  borderRadius: 'var(--radius-sm)',
};

const th = { padding: '11px 16px', fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' };
const td = { padding: '12px 16px', color: 'var(--text)', whiteSpace: 'nowrap' };

window.Preventas = Preventas;
