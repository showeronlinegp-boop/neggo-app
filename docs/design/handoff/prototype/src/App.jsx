// App principal — router, theme/density tweaks, integración con Tweaks panel.

const PAGE_META = {
  dashboard: { title: 'Inicio', subtitle: 'Buen día — esto pasó desde la última vez' },
  products: { title: 'Productos de proveedores', subtitle: 'Tabla unificada con cálculo de costo y venta en vivo' },
  alerts: { title: 'Alertas de precios', subtitle: 'Revisá cambios antes de actualizar Odoo' },
  preventas: { title: 'Preventas — Pedidos de clientes' },
  suppliers: { title: 'Proveedores' },
  scraping: { title: 'Panel de scraping' },
  mappings: { title: 'Vínculos con Odoo' },
  catalogs: { title: 'Catálogos' },
  users: { title: 'Usuarios' },
  activity: { title: 'Log de actividad' },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "comfy",
  "primary": "#1f3a68",
  "accent": "#e25a1c"
}/*EDITMODE-END*/;

const App = () => {
  const [logged, setLogged] = React.useState(true);
  const [page, setPage] = React.useState('dashboard');
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Apply theme/density via data attrs on <html>
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', tweaks.theme);
    document.documentElement.setAttribute('data-density', tweaks.density);
    document.documentElement.style.setProperty('--primary', tweaks.primary);
    document.documentElement.style.setProperty('--accent', tweaks.accent);
  }, [tweaks]);

  if (!logged) return <Login onLogin={() => setLogged(true)} />;

  const meta = PAGE_META[page] || { title: page };

  let content, actions;
  if (page === 'dashboard') {
    content = <Dashboard setPage={setPage} />;
    actions = (
      <>
        <Button size="sm" variant="ghost" leftIcon={<Icons.Refresh size={14} />}>Refrescar</Button>
        <Button size="sm" variant="primary" leftIcon={<Icons.Play size={14} />}>Correr scraping</Button>
      </>
    );
  } else if (page === 'products') {
    content = <Products />;
  } else if (page === 'alerts') {
    content = <Alerts />;
  } else if (page === 'preventas') {
    content = <Preventas />;
  } else {
    content = <ComingSoon page={page} />;
  }

  return (
    <>
      <Layout page={page} setPage={setPage} title={meta.title} subtitle={meta.subtitle} actions={actions}>
        {content}
      </Layout>
      <TweaksPanel title="Tweaks">
        <TweakSection label="Apariencia">
          <TweakRadio label="Tema"
            value={tweaks.theme}
            onChange={v => setTweak('theme', v)}
            options={['light', 'dark']}
          />
          <TweakRadio label="Densidad"
            value={tweaks.density}
            onChange={v => setTweak('density', v)}
            options={['dense', 'comfy', 'airy']}
          />
        </TweakSection>
        <TweakSection label="Colores">
          <TweakColor label="Primario" value={tweaks.primary} onChange={v => setTweak('primary', v)} />
          <TweakColor label="Acento" value={tweaks.accent} onChange={v => setTweak('accent', v)} />
        </TweakSection>
        <TweakSection label="Sesión">
          <TweakButton label="Cerrar sesión (ver Login)" onClick={() => setLogged(false)} />
        </TweakSection>
      </TweaksPanel>
    </>
  );
};

const ComingSoon = ({ page }) => (
  <Card style={{ padding: 60, textAlign: 'center' }}>
    <div style={{
      width: 56, height: 56, borderRadius: 14,
      background: 'var(--surface-2)', color: 'var(--text-muted)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      margin: '0 auto 16px',
    }}><Icons.Settings size={22} /></div>
    <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Sección "{page}" en construcción</div>
    <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', maxWidth: 380, margin: '0 auto' }}>
      Este prototipo se enfoca en Inicio, Productos, Alertas y Preventas. El resto de la sección está en el plan maestro.
    </div>
  </Card>
);

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
