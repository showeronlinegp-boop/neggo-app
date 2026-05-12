import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import Button from '../components/common/Button';
import Input from '../components/common/Input';
import * as Icon from '../components/common/icons';

export default function Login() {
    const { tokens: t } = useTheme();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { login } = useAuth();
    const navigate = useNavigate();

    async function handleSubmit(e) {
        e.preventDefault();
        setError('');

        if (!username.trim() || !password.trim()) {
            setError('Completá usuario y contraseña');
            return;
        }

        setLoading(true);
        const result = await login(username, password);
        setLoading(false);

        if (result.success) {
            navigate('/', { replace: true });
        } else {
            setError(result.error || 'Error al iniciar sesión');
        }
    }

    return (
        <div style={{ display: 'flex', minHeight: '100vh', background: t.color.bg }}>

            {/* Panel de marca — oculto en mobile */}
            <div className="login-brand" style={{
                flex: 1,
                background: t.color.primary,
                color: '#fff',
                padding: '48px 56px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                position: 'relative',
                overflow: 'hidden',
            }}>
                {/* Logo */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative', zIndex: 2 }}>
                    <div style={{
                        width: 38, height: 38, borderRadius: 9,
                        background: 'rgba(255,255,255,0.14)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: t.font.weight.bold, fontSize: 18,
                        fontFamily: t.font.family,
                    }}>n</div>
                    <div style={{ fontSize: 17, fontWeight: t.font.weight.semibold, letterSpacing: '-0.01em', fontFamily: t.font.family }}>
                        Neggo
                    </div>
                </div>

                {/* Tagline + stats */}
                <div style={{ position: 'relative', zIndex: 2, maxWidth: 460 }}>
                    <div style={{
                        fontSize: 36, fontWeight: t.font.weight.semibold,
                        letterSpacing: '-0.03em', lineHeight: 1.15, marginBottom: 20,
                        fontFamily: t.font.family,
                    }}>
                        Tu mayorista,<br />centralizado.
                    </div>
                    <div style={{ fontSize: 15, opacity: 0.78, lineHeight: 1.55, fontFamily: t.font.family }}>
                        Productos de proveedores, alertas de precios y pedidos a un click — sincronizado con Odoo.
                    </div>

                    <div style={{ display: 'flex', gap: 32, marginTop: 36, fontSize: 13, opacity: 0.85 }}>
                        <div>
                            <div style={{ fontSize: 22, fontWeight: t.font.weight.semibold, marginBottom: 2, ...t.numericStyle }}>8.2k</div>
                            <div style={{ opacity: 0.7, fontFamily: t.font.family }}>productos sincronizados</div>
                        </div>
                        <div>
                            <div style={{ fontSize: 22, fontWeight: t.font.weight.semibold, marginBottom: 2, ...t.numericStyle }}>5</div>
                            <div style={{ opacity: 0.7, fontFamily: t.font.family }}>proveedores activos</div>
                        </div>
                    </div>
                </div>

                {/* Grilla decorativa */}
                <div style={{
                    position: 'absolute', inset: 0, opacity: 0.08,
                    backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
                    backgroundSize: '32px 32px',
                    maskImage: 'radial-gradient(ellipse at top right, black, transparent 70%)',
                    WebkitMaskImage: 'radial-gradient(ellipse at top right, black, transparent 70%)',
                }} />
            </div>

            {/* Panel de formulario */}
            <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 32px',
                background: t.color.surface,
            }}>
                <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: 360 }}>
                    <h2 style={{
                        margin: 0,
                        fontSize: 24,
                        fontWeight: t.font.weight.semibold,
                        letterSpacing: '-0.02em',
                        color: t.color.text,
                        fontFamily: t.font.family,
                    }}>
                        Bienvenido de nuevo
                    </h2>
                    <div style={{
                        color: t.color.textMuted,
                        fontSize: t.font.size.base,
                        marginTop: 8,
                        marginBottom: 32,
                        fontFamily: t.font.family,
                    }}>
                        Ingresá con tu cuenta para continuar.
                    </div>

                    {error && (
                        <div style={{
                            background: t.color.dangerSoft,
                            color: t.color.danger,
                            border: `1px solid ${t.color.danger}22`,
                            padding: '10px 14px',
                            borderRadius: t.radius.sm,
                            fontSize: t.font.size.sm,
                            marginBottom: 20,
                            fontFamily: t.font.family,
                        }}>
                            {error}
                        </div>
                    )}

                    <label style={{
                        display: 'block',
                        fontSize: t.font.size.sm,
                        fontWeight: t.font.weight.medium,
                        color: t.color.text,
                        marginBottom: 6,
                        fontFamily: t.font.family,
                    }}>
                        Usuario
                    </label>
                    <Input
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        placeholder="Ingresá tu usuario"
                        autoFocus
                        autoComplete="username"
                        leftIcon={<Icon.Users size={15} />}
                    />

                    <label style={{
                        display: 'block',
                        fontSize: t.font.size.sm,
                        fontWeight: t.font.weight.medium,
                        color: t.color.text,
                        marginBottom: 6,
                        marginTop: t.space[6],
                        fontFamily: t.font.family,
                    }}>
                        Contraseña
                    </label>
                    <Input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••"
                        autoComplete="current-password"
                    />

                    <Button
                        type="submit"
                        variant="primary"
                        disabled={loading}
                        rightIcon={<Icon.ArrowRight size={16} />}
                        style={{ width: '100%', height: 42, marginTop: t.space[8] }}
                    >
                        {loading ? 'Ingresando…' : 'Iniciar sesión'}
                    </Button>

                    <div style={{
                        marginTop: t.space[10],
                        paddingTop: t.space[10],
                        borderTop: `1px solid ${t.color.border}`,
                        fontSize: t.font.size.xs,
                        color: t.color.textFaint,
                        textAlign: 'center',
                        fontFamily: t.font.family,
                    }}>
                        Red interna · Neggo Mayorista · Pergamino
                    </div>
                </form>
            </div>

            {/* El panel de marca se oculta en mobile */}
            <style>{`
                @media (max-width: 760px) {
                    .login-brand { display: none !important; }
                }
            `}</style>
        </div>
    );
}
