// Alertas de precios — cards con comparativa, aprobar/descartar, tabs por estado

const Alerts = () => {
  const [tab, setTab] = React.useState('pending');
  const [alerts, setAlerts] = React.useState(ALERTS);

  const counts = {
    pending: alerts.filter(a => !a.status).length,
    approved: alerts.filter(a => a.status === 'approved').length,
    dismissed: alerts.filter(a => a.status === 'dismissed').length,
  };

  const visible = alerts.filter(a => {
    if (tab === 'pending') return !a.status;
    return a.status === tab;
  });

  const act = (id, status) => {
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, status } : a));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Tabs
        tabs={[
          { value: 'pending', label: 'Pendientes', count: counts.pending },
          { value: 'approved', label: 'Aprobadas', count: counts.approved },
          { value: 'dismissed', label: 'Descartadas', count: counts.dismissed },
        ]}
        value={tab}
        onChange={setTab}
      />

      {visible.length === 0 ? (
        <Card style={{ padding: 60, textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 999,
            background: 'var(--surface-2)', color: 'var(--text-muted)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 14px',
          }}><Icons.Bell size={20} /></div>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Todo al día</div>
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)' }}>
            No hay alertas en esta vista.
          </div>
        </Card>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
          gap: 14,
        }}>
          {visible.map(a => <AlertCard key={a.id} alert={a} onApprove={() => act(a.id, 'approved')} onDismiss={() => act(a.id, 'dismissed')} />)}
        </div>
      )}
    </div>
  );
};

const AlertCard = ({ alert, onApprove, onDismiss }) => {
  const isOoS = alert.type === 'out_of_stock';
  const up = alert.pct > 0;
  const tone = isOoS ? 'danger' : (up ? 'danger' : 'success');

  return (
    <Card padding={false} style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <ProductThumb emoji={alert.image} size={42} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alert.product}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{alert.supplier}</span>
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-faint)' }}>·</span>
            <span className="mono" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-faint)' }}>{alert.sku}</span>
          </div>
        </div>
        {isOoS ? (
          <Badge tone="danger" dot>sin stock</Badge>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: `var(--${tone})`, fontWeight: 600 }}>
            {up ? <Icons.TrendUp size={14} /> : <Icons.TrendDown size={14} />}
            <span className="num" style={{ fontSize: 14 }}>{fmtPct(alert.pct)}</span>
          </div>
        )}
      </div>

      {/* Price comparison */}
      {!isOoS && (
        <div style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: 2 }}>Antes</div>
            <div className="num" style={{ fontSize: 17, fontWeight: 500, color: 'var(--text-muted)', textDecoration: 'line-through' }}>{fmtAR(alert.oldPrice)}</div>
          </div>
          <Icons.ArrowRight size={16} stroke="var(--text-faint)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: 2 }}>Ahora</div>
            <div className="num" style={{ fontSize: 17, fontWeight: 600, color: `var(--${tone})` }}>{fmtAR(alert.newPrice)}</div>
          </div>
        </div>
      )}

      {/* Linked products */}
      {alert.linked.length > 0 && (
        <div style={{
          padding: '12px 16px',
          background: 'var(--surface-2)',
          borderTop: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Vinculados a Odoo · {alert.linked.length}
          </div>
          {alert.linked.map((l, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 0',
              borderTop: i > 0 ? '1px solid var(--border)' : 'none',
            }}>
              <Badge tone={l.company === 'neggo' ? 'primary' : 'accent'} style={{ minWidth: 70, justifyContent: 'center' }}>
                {l.company}
              </Badge>
              <span style={{ flex: 1, fontSize: 'var(--font-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
              <span className="num" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>
                costo {fmtAR(l.currentCost)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{
        padding: '12px 16px', display: 'flex', gap: 8,
        borderTop: '1px solid var(--border)',
        marginTop: 'auto',
      }}>
        {alert.status ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)', color: 'var(--text-muted)' }}>
            {alert.status === 'approved' ? (
              <><Icons.Check size={14} stroke="var(--success)" /> Aprobada · {alert.when}</>
            ) : (
              <><Icons.X size={14} stroke="var(--text-faint)" /> Descartada</>
            )}
          </div>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onDismiss} style={{ flex: 1 }}
              leftIcon={<Icons.X size={14} />}>Descartar</Button>
            <Button size="sm" variant="primary" onClick={onApprove} style={{ flex: 2 }}
              leftIcon={<Icons.Check size={14} />}>Aprobar y actualizar Odoo</Button>
          </>
        )}
      </div>
    </Card>
  );
};

window.Alerts = Alerts;
