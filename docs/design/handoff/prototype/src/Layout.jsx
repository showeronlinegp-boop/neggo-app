// Layout: sidebar + topbar + content. Responsive (sidebar collapse en mobile).

const NAV = [
  { id: 'dashboard', label: 'Inicio', icon: Icons.Dashboard },
  { id: 'products', label: 'Productos', icon: Icons.Box, badge: '8.2k' },
  { id: 'alerts', label: 'Alertas precios', icon: Icons.Bell, badge: 6, tone: 'accent' },
  { id: 'preventas', label: 'Preventas', icon: Icons.Cart },
  { id: 'suppliers', label: 'Proveedores', icon: Icons.Truck },
  { id: 'scraping', label: 'Scraping', icon: Icons.Activity },
  { id: 'mappings', label: 'Vínculos Odoo', icon: Icons.Link },
  { id: 'catalogs', label: 'Catálogos', icon: Icons.Doc },
];

const NAV_ADMIN = [
  { id: 'users', label: 'Usuarios', icon: Icons.Users },
  { id: 'activity', label: 'Actividad', icon: Icons.Eye },
];

const Sidebar = ({ page, setPage, mobileOpen, setMobileOpen }) => {
  const NavItem = ({ item }) => {
    const active = page === item.id;
    const I = item.icon;
    return (
      <button onClick={() => { setPage(item.id); setMobileOpen(false); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          width: '100%', padding: '9px 12px',
          borderRadius: 6,
          background: active ? 'var(--primary-soft)' : 'transparent',
          color: active ? 'var(--primary)' : 'var(--text-muted)',
          fontSize: 'var(--font-sm)', fontWeight: active ? 600 : 500,
          transition: 'all 120ms',
          textAlign: 'left',
        }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-2)'; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
      >
        <I size={17} />
        <span style={{ flex: 1 }}>{item.label}</span>
        {item.badge != null && (
          <span style={{
            fontSize: 'var(--font-xs)', fontWeight: 600,
            padding: '1px 7px', borderRadius: 999,
            background: item.tone === 'accent' ? 'var(--accent)' : (active ? '#fff' : 'var(--surface-2)'),
            color: item.tone === 'accent' ? '#fff' : (active ? 'var(--primary)' : 'var(--text-muted)'),
          }}>{item.badge}</span>
        )}
      </button>
    );
  };

  return (
    <>
      {mobileOpen && (
        <div onClick={() => setMobileOpen(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60,
        }} />
      )}
      <aside style={{
        width: 240,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        flexShrink: 0,
        position: 'sticky', top: 0, height: '100vh',
        zIndex: 70,
      }}
      data-mobile-open={mobileOpen}
      >
        {/* Brand */}
        <div style={{
          padding: '20px 22px 18px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 30, height: 30, borderRadius: 7,
            background: 'var(--primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 14,
            letterSpacing: '-0.02em',
          }}>n</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '-0.01em' }}>Neggo</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: -2 }}>mayorista · pergamino</div>
          </div>
        </div>

        <div style={{ padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 2, flex: 1, overflow: 'auto' }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-faint)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            padding: '12px 12px 6px',
          }}>Operación</div>
          {NAV.map(item => <NavItem key={item.id} item={item} />)}

          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-faint)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            padding: '20px 12px 6px',
          }}>Admin</div>
          {NAV_ADMIN.map(item => <NavItem key={item.id} item={item} />)}
        </div>

        {/* User */}
        <div style={{
          padding: 12, borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 999,
            background: 'oklch(0.85 0.04 60)',
            color: 'var(--text)', fontWeight: 600, fontSize: 12,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>JM</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500 }}>Juan M.</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>admin</div>
          </div>
          <button style={{
            width: 28, height: 28, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)',
          }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          ><Icons.Logout size={15} /></button>
        </div>
      </aside>

      <style>{`
        @media (max-width: 880px) {
          aside[data-mobile-open] {
            position: fixed !important;
            transform: translateX(-100%);
            transition: transform 220ms ease;
          }
          aside[data-mobile-open="true"] {
            transform: translateX(0);
          }
        }
      `}</style>
    </>
  );
};

const Topbar = ({ title, subtitle, actions, onMenuClick }) => (
  <div style={{
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px var(--pad-x) 18px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
    gap: 16, flexWrap: 'wrap',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <button onClick={onMenuClick} className="menu-btn" style={{
        width: 36, height: 36, borderRadius: 6,
        display: 'none', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', border: '1px solid var(--border)',
      }}><Icons.Menu size={18} /></button>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.2 }}>{title}</h1>
        {subtitle && <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', marginTop: 4 }}>{subtitle}</div>}
      </div>
    </div>
    {actions && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>{actions}</div>}
    <style>{`
      @media (max-width: 880px) {
        .menu-btn { display: flex !important; }
      }
    `}</style>
  </div>
);

const Layout = ({ page, setPage, title, subtitle, actions, children }) => {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      <Sidebar page={page} setPage={setPage} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Topbar title={title} subtitle={subtitle} actions={actions} onMenuClick={() => setMobileOpen(true)} />
        <main style={{ flex: 1, padding: 'var(--pad-y) var(--pad-x)', overflow: 'auto' }}>
          {children}
        </main>
      </div>
    </div>
  );
};

Object.assign(window, { Layout });
