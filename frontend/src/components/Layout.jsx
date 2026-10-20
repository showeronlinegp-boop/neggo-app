import { useState, useEffect, useCallback, useRef } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useScrapingContext } from '../context/ScrapingContext';
import { useTheme } from '../theme/ThemeContext';
import * as Icon from './common/icons';
import api from '../api/client';
import TestNotes from './testNotes/TestNotes';

// ─── Mapa de rutas a títulos ────────────────────────────────────────────────────
const routeTitles = {
    '/':                             'Dashboard',
    '/proveedores':                  'Proveedores',
    '/productos':                    'Productos',
    '/productos/sync-preventas':     'Sincronización Preventas',
    '/alertas':                      'Alertas de precios',
    '/scraping':                     'Panel de scraping',
    '/ingreso/new':                  'Ingreso de Mercadería',
    '/ingreso':                      'Ingreso de Mercadería',
    '/reposicion':                   'Reposición',
    '/reposicion/recorrida':         'Recorrida de depósito',
    '/preventas/pedidos':            'Pedidos',
    '/preventas/ordenes':            'Órdenes a proveedores',
    '/preventas/catalogos':          'Catálogos',
    '/preventas/cotizaciones':       'Cotizaciones Odoo — Preventas',
    '/preventas/ordenes-odoo':       'Pedidos por proveedor — Cotizaciones Odoo',
    '/preventas/listas-precios':     'Listas de precios especiales',
    '/admin':                        'Panel de administración',
    '/admin/odoo-products':          'Productos Odoo',
    '/admin/whatsapp':               'WhatsApp',
    '/usuarios':                     'Usuarios',
    '/actividad':                    'Log de actividad',
};

// ─── Ítems de navegación ────────────────────────────────────────────────────────
const NAV_ITEMS = [
    { icon: Icon.LayoutDashboard, label: 'Dashboard',              path: '/' },
    { icon: Icon.Truck,           label: 'Proveedores',            path: '/proveedores',           roles: ['admin'], unmappedBadge: true },
    { icon: Icon.Bot,             label: 'Scraping',               path: '/scraping',              roles: ['admin'] },
    { icon: Icon.PackageDown,     label: 'Ingreso de Mercadería',  path: '/ingreso',               roles: ['admin', 'operador'] },
    { icon: Icon.Refresh,         label: 'Reposición',             path: '/reposicion',            roles: ['admin', 'operador'] },
    {
        icon: Icon.Package, label: 'Productos',
        roles: ['admin', 'operador'],
        children: [
            { label: 'Lista de productos',   path: '/productos',                roles: ['admin', 'operador'] },
            { label: 'Sync Preventas',       path: '/productos/sync-preventas', roles: ['admin'] },
            { label: 'Vínculos Odoo',        path: '/productos/vinculos',       roles: ['admin'] },
        ],
    },
    { icon: Icon.Bell,         label: 'Alertas de precio',      path: '/alertas',               roles: ['admin'], badge: true },
    { icon: Icon.ShoppingCart, label: 'Pedidos',                path: '/preventas/pedidos',         roles: ['admin', 'vendedor', 'operador'] },
    { icon: Icon.ClipboardList,label: 'Órdenes a proveedores',  path: '/preventas/ordenes',         roles: ['admin', 'operador'] },
    { icon: Icon.Tag,          label: 'Listas de precios',      path: '/preventas/listas-precios',  roles: ['admin'] },
    { icon: Icon.BookOpen,     label: 'Catálogos',              path: '/preventas/catalogos',       roles: ['admin', 'vendedor'] },
    { icon: Icon.FileText,     label: 'Cotizaciones Odoo',      path: '/preventas/cotizaciones',    roles: ['admin', 'operador'] },
    { icon: Icon.ShoppingBag,  label: 'Pedidos x Proveedor',   path: '/preventas/ordenes-odoo',    roles: ['admin', 'operador'] },
];

const ADMIN_ITEMS = [
    { icon: Icon.Settings,  label: 'Administración',  path: '/admin' },
    { icon: Icon.Database,  label: 'Productos Odoo',  path: '/admin/odoo-products' },
    { icon: Icon.MessageCircle, label: 'WhatsApp',     path: '/admin/whatsapp' },
    { icon: Icon.Users,     label: 'Usuarios',         path: '/usuarios' },
    { icon: Icon.Activity,  label: 'Actividad',        path: '/actividad' },
];

// ─── Breakpoint mobile ──────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 880) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
        const handler = (e) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [breakpoint]);
    return isMobile;
}

// ─── Terminal global de scraping (siempre oscura, es una terminal) ───────────
function ScrapingTerminal() {
    const { terminal, pauseRun, closeTerminal, activeRuns } = useScrapingContext();
    const endRef = useRef(null);

    useEffect(() => {
        if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [terminal.lines]);

    if (!terminal.open) return null;

    const isRunning = !terminal.done && !!activeRuns[terminal.supplierId];
    const canPause  = isRunning && activeRuns[terminal.supplierId] !== 'starting';

    const statusColor = terminal.done
        ? (terminal.status === 'completed' ? '#85e89d'
         : terminal.status === 'failed'    ? '#f97583'
         : terminal.status === 'paused'    ? '#ffab70' : '#ccc')
        : '#ffab70';

    const statusLabel = terminal.done
        ? (terminal.status === 'completed' ? '✅ Completado'
         : terminal.status === 'failed'    ? '❌ Falló'
         : terminal.status === 'paused'    ? '⏸ Pausado'
         : terminal.status === 'cancelled' ? '🛑 Cancelado'
         : `● ${terminal.status}`)
        : '⏳ Ejecutando...';

    return (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 2000, background: '#161b22', borderTop: '2px solid #30363d', boxShadow: '0 -4px 24px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #30363d', background: '#0d1117' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ color: '#e6edf3', fontWeight: 600, fontSize: 13 }}>🖥 {terminal.supplierName}</span>
                    {terminal.productCount > 0 && (
                        <span style={{ background: '#003366', color: '#79c0ff', padding: '1px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>
                            {terminal.productCount} productos
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: statusColor }}>{statusLabel}</span>
                    <span style={{ color: '#555', fontSize: 11 }}>{terminal.lines.length} líneas</span>
                    {canPause && (
                        <button onClick={() => pauseRun(terminal.supplierId)} style={{ background: 'none', border: '1px solid #ffab70', color: '#ffab70', cursor: 'pointer', fontSize: 12, padding: '2px 8px', borderRadius: 4 }}>
                            ⏸ Pausar
                        </button>
                    )}
                    <button onClick={closeTerminal} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16, padding: '2px 6px', borderRadius: 4, lineHeight: 1 }}>✕</button>
                </div>
            </div>
            <div style={{ background: '#0d1117', padding: '10px 16px', fontFamily: '"JetBrains Mono", "Courier New", monospace', fontSize: 12, lineHeight: 1.7, height: 220, overflowY: 'auto', color: '#e6edf3', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {terminal.lines.length === 0 && !terminal.done && <span style={{ color: '#555' }}>Esperando logs del scraper...</span>}
                {terminal.lines.map((line, i) => (
                    <div key={i} style={{ color: line.startsWith('❌') ? '#f97583' : line.startsWith('✅') ? '#85e89d' : line.startsWith('⚠️') || line.startsWith('⏸') ? '#ffab70' : line.startsWith('📦') ? '#79c0ff' : line.startsWith('📊') ? '#d2a8ff' : '#e6edf3', marginBottom: 1 }}>{line}</div>
                ))}
                <div ref={endRef} />
            </div>
        </div>
    );
}

// ─── Topbar (exportado para uso en páginas) ─────────────────────────────────────
export function Topbar({ title, subtitle, actions, onMenuClick }) {
    const { tokens: t } = useTheme();

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `${t.layout.cardPadY}px ${t.layout.cardPadX}px 18px`,
            borderBottom: `1px solid ${t.color.border}`,
            background: t.color.surface,
            gap: 16,
            flexWrap: 'wrap',
            flexShrink: 0,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                {onMenuClick && (
                    <button
                        type="button"
                        onClick={onMenuClick}
                        style={{
                            width: 36, height: 36, borderRadius: t.radius.sm,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: t.color.textMuted, border: `1px solid ${t.color.border}`,
                            cursor: 'pointer', background: 'transparent',
                        }}
                    >
                        <Icon.Menu size={18} />
                    </button>
                )}
                <div style={{ minWidth: 0 }}>
                    <h1 style={{
                        margin: 0,
                        fontSize: t.font.size.xl,
                        fontWeight: t.font.weight.semibold,
                        letterSpacing: '-0.02em',
                        lineHeight: 1.2,
                        color: t.color.text,
                        fontFamily: t.font.family,
                    }}>
                        {title}
                    </h1>
                    {subtitle && (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {subtitle}
                        </div>
                    )}
                </div>
            </div>
            {actions && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {actions}
                </div>
            )}
        </div>
    );
}

// ─── Layout principal ────────────────────────────────────────────────────────────
export default function Layout() {
    const { tokens: t } = useTheme();
    const { user, logout } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const isMobile = useIsMobile();

    const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
    const [alertCount, setAlertCount] = useState(0);
    const [unmappedCount, setUnmappedCount] = useState(0);
    const [expandedGroups, setExpandedGroups] = useState(() => {
        const initial = {};
        for (const item of NAV_ITEMS) {
            if (item.children) {
                initial[item.label] = item.children.some(c => location.pathname.startsWith(c.path));
            }
        }
        return initial;
    });

    const toggleGroup = useCallback((label) => {
        setExpandedGroups(prev => ({ ...prev, [label]: !prev[label] }));
    }, []);

    useEffect(() => { setSidebarOpen(!isMobile); }, [isMobile]);

    useEffect(() => {
        api.get('/alerts/summary')
            .then(res => { if (res.success) setAlertCount(res.data?.pending ?? 0); })
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (user?.role !== 'admin') return;
        api.get('/suppliers/unmapped-summary')
            .then(res => { if (res.success) setUnmappedCount(res.data?.totalUnmapped ?? 0); })
            .catch(() => {});
    }, [user?.role]);

    const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), []);

    const handleLogout = useCallback(() => {
        logout();
        navigate('/login', { replace: true });
    }, [logout, navigate]);

    const pageTitle = routeTitles[location.pathname]
        ?? (location.pathname.startsWith('/proveedores/') ? 'Reglas del proveedor' : 'Neggo');

    const displayName = user?.displayName || user?.display_name || 'Usuario';
    const initials = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

    return (
        <div style={{ display: 'flex', minHeight: '100vh', background: t.color.bg }}>

            {/* Overlay mobile */}
            {isMobile && sidebarOpen && (
                <div
                    onClick={toggleSidebar}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60 }}
                />
            )}

            {/* ── SIDEBAR ── */}
            <aside style={{
                width: t.layout.sidebarWidth,
                background: t.color.surface,
                borderRight: `1px solid ${t.color.border}`,
                display: 'flex',
                flexDirection: 'column',
                flexShrink: 0,
                // Desktop: sticky; Mobile: fixed con slide
                ...(isMobile ? {
                    position: 'fixed',
                    top: 0, left: 0, bottom: 0,
                    zIndex: 70,
                    transform: sidebarOpen ? 'translateX(0)' : `translateX(-${t.layout.sidebarWidth}px)`,
                    transition: 'transform 220ms ease',
                } : {
                    position: 'sticky',
                    top: 0,
                    height: '100vh',
                    zIndex: 70,
                }),
            }}>
                {/* Marca */}
                <div style={{ padding: '20px 22px 18px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    <div style={{
                        width: 30, height: 30, borderRadius: t.radius.sm,
                        background: t.color.primary,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#fff', fontWeight: t.font.weight.bold, fontSize: 14, letterSpacing: '-0.02em',
                    }}>n</div>
                    <div>
                        <div style={{ fontWeight: t.font.weight.semibold, fontSize: 15, letterSpacing: '-0.01em', color: t.color.text }}>Neggo</div>
                        <div style={{ fontSize: 11, color: t.color.textFaint, marginTop: -2 }}>mayorista · pergamino</div>
                    </div>
                </div>

                {/* Nav items */}
                <div style={{ padding: '0 10px', display: 'flex', flexDirection: 'column', gap: 2, flex: 1, overflowY: 'auto' }}>
                    <SectionLabel label="Operación" tokens={t} />
                    {NAV_ITEMS
                        .filter(item => !item.roles || item.roles.includes(user?.role))
                        .map(item => item.children ? (
                            <NavGroup
                                key={item.label}
                                item={item}
                                userRole={user?.role}
                                currentPath={location.pathname}
                                isOpen={!!expandedGroups[item.label]}
                                onToggle={() => toggleGroup(item.label)}
                                onNavigate={isMobile ? toggleSidebar : undefined}
                                tokens={t}
                            />
                        ) : (
                            <NavItem
                                key={item.path}
                                item={item}
                                alertCount={alertCount}
                                unmappedCount={unmappedCount}
                                currentPath={location.pathname}
                                onNavigate={isMobile ? toggleSidebar : undefined}
                                tokens={t}
                            />
                        ))
                    }

                    {user?.role === 'admin' && (
                        <>
                            <SectionLabel label="Admin" tokens={t} top />
                            {ADMIN_ITEMS.map(item => (
                                <NavItem
                                    key={item.path}
                                    item={item}
                                    alertCount={0}
                                    unmappedCount={0}
                                    currentPath={location.pathname}
                                    onNavigate={isMobile ? toggleSidebar : undefined}
                                    tokens={t}
                                />
                            ))}
                        </>
                    )}
                </div>

                {/* Usuario */}
                <div style={{
                    padding: 12,
                    borderTop: `1px solid ${t.color.border}`,
                    display: 'flex', alignItems: 'center', gap: 10,
                    flexShrink: 0,
                }}>
                    <div style={{
                        width: 32, height: 32, borderRadius: t.radius.full,
                        background: t.color.primarySoft,
                        color: t.color.primary, fontWeight: t.font.weight.semibold, fontSize: 12,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                    }}>
                        {initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {displayName}
                        </div>
                        <div style={{ fontSize: 11, color: t.color.textFaint }}>{user?.role}</div>
                    </div>
                    <LogoutButton onLogout={handleLogout} tokens={t} />

                </div>
            </aside>

            {/* ── CONTENIDO ── */}
            <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                // En mobile el sidebar es fixed (no empuja el contenido), pero en desktop no
                marginLeft: isMobile ? 0 : 0,
            }}>
                <Topbar
                    title={pageTitle}
                    onMenuClick={isMobile ? toggleSidebar : undefined}
                />
                {/* data-app-main: contenedor que scrollea (lo usan los pines de las notas de prueba) */}
                <main data-app-main="" style={{
                    flex: 1,
                    padding: t.layout.cardPadY,
                    overflowY: 'auto',
                    paddingBottom: 48,
                }}>
                    <Outlet />
                </main>
            </div>

            {/* Terminal de scraping — siempre visible sobre todo */}
            <ScrapingTerminal />

            {/* Notas de prueba: solo admins; se oculta sola si el backend no las habilita */}
            {user?.role === 'admin' && <TestNotes pantalla={pageTitle} />}
        </div>
    );
}

// ─── Componentes internos ────────────────────────────────────────────────────────

function SectionLabel({ label, tokens: t, top = false }) {
    return (
        <div style={{
            fontSize: 11,
            fontWeight: t.font.weight.semibold,
            color: t.color.textFaint,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            padding: `${top ? 20 : 12}px 12px 6px`,
            fontFamily: t.font.family,
        }}>
            {label}
        </div>
    );
}

function NavGroup({ item, userRole, currentPath, isOpen, onToggle, onNavigate, tokens: t }) {
    const [hovered, setHovered] = useState(false);
    const visibleChildren = item.children.filter(c => !c.roles || c.roles.includes(userRole));
    if (visibleChildren.length === 0) return null;

    const hasActiveChild = visibleChildren.some(c => currentPath.startsWith(c.path));
    const active = hasActiveChild;

    return (
        <>
            <button
                type="button"
                onClick={onToggle}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    width: '100%', padding: '9px 12px',
                    borderRadius: t.radius.sm,
                    background: active ? t.color.primarySoft : hovered ? t.color.surface2 : 'transparent',
                    color: active ? t.color.primary : t.color.textMuted,
                    fontSize: t.font.size.sm, fontWeight: active ? t.font.weight.semibold : t.font.weight.medium,
                    transition: 'all 120ms', cursor: 'pointer', textAlign: 'left',
                    fontFamily: t.font.family,
                }}
            >
                <item.icon size={17} color="currentColor" />
                <span style={{ flex: 1 }}>{item.label}</span>
                <Icon.ChevronRight size={12} color={t.color.textFaint} style={{ transition: 'transform 150ms', transform: (isOpen || hasActiveChild) ? 'rotate(90deg)' : 'none' }} />
            </button>
            {(isOpen || hasActiveChild) && visibleChildren.map(child => (
                <NavItem
                    key={child.path}
                    item={child}
                    alertCount={0}
                    unmappedCount={0}
                    currentPath={currentPath}
                    onNavigate={onNavigate}
                    isChild
                    tokens={t}
                />
            ))}
        </>
    );
}

function NavItem({ item, alertCount = 0, unmappedCount = 0, currentPath, onNavigate, isChild = false, tokens: t }) {
    const [hovered, setHovered] = useState(false);
    const isActive = currentPath === item.path || (item.path !== '/' && currentPath.startsWith(item.path + '/'));
    const badgeCount = item.badge ? alertCount : item.unmappedBadge ? unmappedCount : 0;

    return (
        <NavLink to={item.path} style={{ textDecoration: 'none' }} onClick={onNavigate}>
            <div
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: isChild ? '7px 12px 7px 28px' : '9px 12px',
                    borderRadius: t.radius.sm,
                    background: isActive ? t.color.primarySoft : hovered ? t.color.surface2 : 'transparent',
                    color: isActive ? t.color.primary : t.color.textMuted,
                    fontSize: t.font.size.sm,
                    fontWeight: isActive ? t.font.weight.semibold : t.font.weight.medium,
                    transition: 'all 120ms',
                    fontFamily: t.font.family,
                }}
            >
                {!isChild && (
                    <item.icon size={17} color="currentColor" />
                )}
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.label}
                </span>
                {badgeCount > 0 && (
                    <span style={{
                        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
                        padding: '1px 7px', borderRadius: t.radius.full,
                        background: item.badge ? t.color.danger : t.color.accentSoft,
                        color: item.badge ? '#fff' : t.color.accent,
                    }}>
                        {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                )}
            </div>
        </NavLink>
    );
}

function LogoutButton({ onLogout, tokens: t }) {
    const [hovered, setHovered] = useState(false);
    return (
        <button
            type="button"
            onClick={onLogout}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            title="Salir"
            style={{
                width: 28, height: 28, borderRadius: t.radius.sm,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: t.color.textMuted,
                background: hovered ? t.color.surface2 : 'transparent',
                cursor: 'pointer',
                flexShrink: 0,
                transition: 'background 120ms',
            }}
        >
            <Icon.LogOut size={15} />
        </button>
    );
}
