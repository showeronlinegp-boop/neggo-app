// Dashboard — KPIs, alertas pendientes, último scraping, pedidos activos, actividad

const Dashboard = ({ setPage }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* KPIs row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 14,
      }}>
        <Card>
          <Stat label="Alertas pendientes" value="6"
            tone="accent"
            hint="2 con suba > 10%"
            icon={<Icons.Bell size={14} />} />
        </Card>
        <Card>
          <Stat label="Pedidos activos" value="14"
            hint="3 esperando OC en Odoo"
            icon={<Icons.Cart size={14} />} />
        </Card>
        <Card>
          <Stat label="Productos sincronizados" value="8.2k"
            hint="vinculados a Odoo: 73%"
            icon={<Icons.Box size={14} />} />
        </Card>
        <Card>
          <Stat label="Último scraping" value="hace 2h"
            hint="5 proveedores · 4.2k cambios"
            icon={<Icons.Activity size={14} />} />
        </Card>
      </div>

      {/* Two-col content */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
        gap: 14,
      }} className="dash-grid">
        {/* Alertas pendientes */}
        <Card padding={false}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '18px 22px', borderBottom: '1px solid var(--border)',
          }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>Alertas que requieren atención</div>
              <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', marginTop: 2 }}>Revisá cambios de precio antes de actualizar Odoo</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setPage('alerts')}
              rightIcon={<Icons.ArrowRight size={14} />}>Ver todas</Button>
          </div>
          <div>
            {ALERTS.slice(0, 4).map((a, i) => (
              <div key={a.id} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 22px',
                borderBottom: i < 3 ? '1px solid var(--border)' : 'none',
              }}>
                <ProductThumb emoji={a.image} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 'var(--font-sm)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.product}</span>
                  </div>
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>{a.supplier}</span>
                    <span>·</span>
                    <span className="mono">{a.sku}</span>
                    <span>·</span>
                    <span>{a.when}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  {a.type === 'out_of_stock' ? (
                    <Badge tone="danger" dot>sin stock</Badge>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {a.pct > 0 ? <Icons.TrendUp size={14} stroke="var(--danger)" /> : <Icons.TrendDown size={14} stroke="var(--success)" />}
                      <span className="num" style={{
                        fontSize: 'var(--font-sm)', fontWeight: 600,
                        color: a.pct > 0 ? 'var(--danger)' : 'var(--success)',
                      }}>{fmtPct(a.pct)}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Right column: scraping + activity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card padding={false}>
            <div style={{ padding: '18px 22px 12px' }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>Scraping de hoy</div>
              <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', marginTop: 2 }}>5 proveedores</div>
            </div>
            <div style={{ padding: '0 22px 18px' }}>
              {SUPPLIERS.map((s, i) => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 0',
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: 999,
                    background: s.status === 'ok' ? 'var(--success)' : s.status === 'warn' ? 'var(--warn)' : 'var(--danger)',
                  }} />
                  <span style={{ fontSize: 'var(--font-sm)', flex: 1, fontWeight: 500 }}>{s.name}</span>
                  <span className="num" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{s.products.toLocaleString('es-AR')}</span>
                  <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-faint)', minWidth: 60, textAlign: 'right' }}>{s.lastRun}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card padding={false}>
            <div style={{ padding: '18px 22px 12px' }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>Actividad reciente</div>
            </div>
            <div style={{ padding: '0 22px 18px' }}>
              {ACTIVITY.map((a, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '10px 0',
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: 999,
                    background: 'var(--surface-2)', color: 'var(--text-muted)',
                    fontSize: 10, fontWeight: 600, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginTop: 1,
                  }}>{a.user[0]}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--font-sm)', lineHeight: 1.4 }}>
                      <span style={{ fontWeight: 500 }}>{a.user}</span>{' '}
                      <span style={{ color: 'var(--text-muted)' }}>{a.action}</span>
                    </div>
                    <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-faint)', marginTop: 2 }}>
                      {a.detail} · {a.when}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <style>{`
        @media (max-width: 980px) {
          .dash-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
};

window.Dashboard = Dashboard;
