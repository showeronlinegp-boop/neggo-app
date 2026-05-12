// Login screen — split layout, brand izquierda, formulario derecha.

const Login = ({ onLogin }) => {
  const [user, setUser] = React.useState('juan');
  const [pass, setPass] = React.useState('••••••••');
  const [loading, setLoading] = React.useState(false);

  const submit = (e) => {
    e?.preventDefault();
    setLoading(true);
    setTimeout(() => { setLoading(false); onLogin(); }, 600);
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Left brand panel */}
      <div className="login-brand" style={{
        flex: 1, background: 'var(--primary)',
        color: '#fff', padding: '48px 56px',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative', zIndex: 2 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 9,
            background: 'rgba(255,255,255,0.14)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: 18,
          }}>n</div>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>Neggo</div>
        </div>

        <div style={{ position: 'relative', zIndex: 2, maxWidth: 460 }}>
          <div style={{
            fontSize: 36, fontWeight: 600, letterSpacing: '-0.03em',
            lineHeight: 1.15, marginBottom: 20,
          }}>
            Tu mayorista,<br/>centralizado.
          </div>
          <div style={{ fontSize: 15, opacity: 0.78, lineHeight: 1.55 }}>
            Productos de proveedores, alertas de precios y pedidos a un click — sincronizado con Odoo.
          </div>

          <div style={{ display: 'flex', gap: 32, marginTop: 36, fontSize: 13, opacity: 0.85 }}>
            <div>
              <div className="num" style={{ fontSize: 22, fontWeight: 600, marginBottom: 2 }}>8.2k</div>
              <div style={{ opacity: 0.7 }}>productos sincronizados</div>
            </div>
            <div>
              <div className="num" style={{ fontSize: 22, fontWeight: 600, marginBottom: 2 }}>5</div>
              <div style={{ opacity: 0.7 }}>proveedores activos</div>
            </div>
          </div>
        </div>

        {/* Decorative grid */}
        <div style={{
          position: 'absolute', inset: 0, opacity: 0.08,
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          maskImage: 'radial-gradient(ellipse at top right, black, transparent 70%)',
        }} />
      </div>

      {/* Right form */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '48px 32px', background: 'var(--surface)',
      }}>
        <form onSubmit={submit} style={{ width: '100%', maxWidth: 360 }}>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' }}>Bienvenido de nuevo</h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 8, marginBottom: 32 }}>
            Ingresá con tu cuenta para continuar.
          </div>

          <label style={{ display: 'block', fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 6 }}>Usuario</label>
          <Input value={user} onChange={e => setUser(e.target.value)} placeholder="usuario" leftIcon={<Icons.Users size={16} />} />

          <label style={{ display: 'block', fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 6, marginTop: 16 }}>Contraseña</label>
          <Input value={pass} onChange={e => setPass(e.target.value)} type="password" placeholder="••••••••" />

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" style={{
              fontSize: 'var(--font-sm)', color: 'var(--text-muted)',
            }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
            >Olvidaste tu contraseña?</button>
          </div>

          <Button variant="primary" type="submit" style={{ width: '100%', height: 42, marginTop: 20 }}
            rightIcon={<Icons.ArrowRight size={16} />}>
            {loading ? 'Ingresando…' : 'Iniciar sesión'}
          </Button>

          <div style={{
            marginTop: 24, paddingTop: 24, borderTop: '1px solid var(--border)',
            fontSize: 'var(--font-xs)', color: 'var(--text-faint)', textAlign: 'center',
          }}>
            Red interna · 192.168.1.100 · v0.4.2
          </div>
        </form>
      </div>

      <style>{`
        @media (max-width: 760px) {
          .login-brand { display: none; }
        }
      `}</style>
    </div>
  );
};

window.Login = Login;
