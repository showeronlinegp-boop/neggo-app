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
    '/productos/vinculos':           'Vínculos Odoo',
    '/ingreso/new':                  'Ingreso de mercadería',
    '/ingreso':                      'Ingreso de mercadería',
    '/reposicion':                   'Reposición',
    '/clientes':                     'Clientes',
    '/clientes/mi-dia':              'Mi día',
    '/reposicion/recorrida':         'Recorrida de depósito',
    '/pedidos/armado':               'Armado y control',
    '/preventas/pedidos':            'Pedidos de clientes',
    '/preventas/ordenes':            'Órdenes de compra',
    '/preventas/catalogos':          'Catálogos PDF',
    '/preventas/cotizaciones':       'Cotizaciones Odoo — Preventas',
    '/preventas/ordenes-odoo':       'Pedidos por proveedor — Cotizaciones Odoo',
    '/preventas/listas-precios':     'Listas de precios especiales',
    '/admin':                        'Panel de administración',
    '/admin/odoo-products':          'Productos Odoo',
    '/admin/whatsapp':               'WhatsApp',
    '/admin/estados':                'Imágenes para estados',
    '/usuarios':                     'Usuarios',
    '/actividad':                    'Log de actividad',
};

// ─── Ítems de navegación ────────────────────────────────────────────────────────
// Dashboard va suelto arriba; el resto se agrupa siguiendo el recorrido del negocio.
// `exact`: solo se marca activo en esa ruta (no en sus subrutas, que tienen ítem propio).
const NAV_HOME = { icon: Icon.LayoutDashboard, label: 'Dashboard', path: '/' };

const NAV_GROUPS = [
    {
        label: 'Ventas',
        items: [
            { icon: Icon.Users,         label: 'Clientes',              path: '/clientes',                 roles: ['admin', 'vendedor'], exact: true },
            { icon: Icon.Check,         label: 'Mi día',                path: '/clientes/mi-dia',          roles: ['admin', 'vendedor'] },
        ],
    },
    {
        label: 'Depósito',
        items: [
            { icon: Icon.PackageDown,   label: 'Ingreso de mercadería', path: '/ingreso',                  roles: ['admin', 'operador'] },
            { icon: Icon.Refresh,       label: 'Reposición',            path: '/reposicion',               roles: ['admin', 'operador'] },
            { icon: Icon.ScanBarcode,   label: 'Armado y control',      path: '/pedidos/armado',           roles: ['admin', 'operador'] },
        ],
    },
    {
        label: 'Preventas',
        items: [
            { icon: Icon.ShoppingCart,  label: 'Pedidos de clientes',   path: '/preventas/pedidos',        roles: ['admin', 'vendedor', 'operador'] },
            { icon: Icon.FileText,      label: 'Cotizaciones Odoo',     path: '/preventas/cotizaciones',   roles: ['admin', 'operador'] },
            { icon: Icon.ShoppingBag,   label: 'Pedidos por proveedor', path: '/preventas/ordenes-odoo',   roles: ['admin', 'operador'] },
            { icon: Icon.ClipboardList, label: 'Órdenes de compra',     path: '/preventas/ordenes',        roles: ['admin', 'operador'] },
        ],
    },
    {
        label: 'Catálogo y precios',
        items: [
            { icon: Icon.Package,       label: 'Productos',             path: '/productos',                roles: ['admin', 'operador'], exact: true },
            { icon: Icon.Bell,          label: 'Alertas de precio',     path: '/alertas',                  roles: ['admin'], badge: true },
            { icon: Icon.Truck,         label: 'Proveedores',           path: '/proveedores',              roles: ['admin'], unmappedBadge: true },
            { icon: Icon.Link,          label: 'Vínculos Odoo',         path: '/productos/vinculos',       roles: ['admin'] },
            { icon: Icon.ArrowRight,    label: 'Sync Preventas',        path: '/productos/sync-preventas', roles: ['admin'] },
        ],
    },
    {
        label: 'Difusión',
        items: [
            { icon: Icon.BookOpen,      label: 'Catálogos PDF',         path: '/preventas/catalogos',      roles: ['admin', 'vendedor'] },
            { icon: Icon.MessageCircle, label: 'WhatsApp',              path: '/admin/whatsapp',           roles: ['admin'] },
            { icon: Icon.Image,         label: 'Imágenes para estados', path: '/admin/estados',            roles: ['admin'] },
        ],
    },
    {
        label: 'Sistema',
        items: [
            { icon: Icon.Bot,           label: 'Scraping',              path: '/scraping',                 roles: ['admin'] },
            { icon: Icon.Database,      label: 'Productos Odoo',        path: '/admin/odoo-products',      roles: ['admin'] },
            { icon: Icon.Tag,           label: 'Listas de precios',     path: '/preventas/listas-precios', roles: ['admin'] },
            { icon: Icon.Users,         label: 'Usuarios',              path: '/usuarios',                 roles: ['admin'] },
            { icon: Icon.Activity,      label: 'Actividad',             path: '/actividad',                roles: ['admin'] },
            { icon: Icon.Settings,      label: 'Administración',        path: '/admin',                    roles: ['admin'], exact: true },
        ],
    },
];

// Grupos que el usuario abrió/cerró a mano (se recuerdan entre sesiones)
const NAV_STORAGE_KEY = 'neggo.nav.gruposAbiertos';

function leerGruposAbiertos() {
    try { return JSON.parse(localStorage.getItem(NAV_STORAGE_KEY)) || {}; } catch { return {}; }
}

// Menú lateral comprimido (solo íconos) en la compu: también se recuerda
const NAV_COMPACTO_KEY = 'neggo.nav.compacto';
const SIDEBAR_COMPACTO = 68;

function leerCompacto() {
    try { return localStorage.getItem(NAV_COMPACTO_KEY) === '1'; } catch { return false; }
}

function isPathActive(item, currentPath) {
    if (currentPath === item.path) return true;
    if (item.exact || item.path === '/') return false;
    return currentPath.startsWith(item.path + '/');
}

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
    const [openGroups, setOpenGroups] = useState(leerGruposAbiertos);
    const [compactoGuardado, setCompactoGuardado] = useState(leerCompacto);
    // En el celular el menú se abre entero sobre la pantalla: nunca va comprimido
    const compacto = compactoGuardado && !isMobile;

    const toggleCompacto = useCallback(() => {
        setCompactoGuardado(prev => {
            try { localStorage.setItem(NAV_COMPACTO_KEY, prev ? '0' : '1'); } catch { /* sin storage: queda en memoria */ }
            return !prev;
        });
    }, []);

    const toggleGroup = useCallback((label, isOpen) => {
        setOpenGroups(prev => {
            const next = { ...prev, [label]: !isOpen };
            try { localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(next)); } catch { /* sin storage: queda en memoria */ }
            return next;
        });
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
        ?? (location.pathname.startsWith('/pedidos/armado') ? 'Armado y control'
            : location.pathname.startsWith('/ingreso/') ? 'Ingreso de mercadería'
            : location.pathname.startsWith('/proveedores/') ? 'Reglas del proveedor' : 'Neggo');

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
                width: compacto ? SIDEBAR_COMPACTO : t.layout.sidebarWidth,
                transition: 'width 180ms ease',
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
                {/* Marca + botón para comprimir el menú (solo en la compu) */}
                <div style={{
                    padding: compacto ? '20px 0 12px' : '20px 12px 18px 22px',
                    display: 'flex', flexDirection: compacto ? 'column' : 'row', alignItems: 'center', gap: 10, flexShrink: 0,
                }}>
                    <div style={{
                        width: 30, height: 30, borderRadius: t.radius.sm, flexShrink: 0,
                        background: t.color.primary,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#fff', fontWeight: t.font.weight.bold, fontSize: 14, letterSpacing: '-0.02em',
                    }}>n</div>
                    {!compacto && (
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: t.font.weight.semibold, fontSize: 15, letterSpacing: '-0.01em', color: t.color.text }}>Neggo</div>
                            <div style={{ fontSize: 11, color: t.color.textFaint, marginTop: -2, whiteSpace: 'nowrap' }}>mayorista · pergamino</div>
                        </div>
                    )}
                    {!isMobile && <BotonCompacto compacto={compacto} onToggle={toggleCompacto} tokens={t} />}
                </div>

                {/* Nav items */}
                <div style={{ padding: compacto ? '0 8px' : '0 10px', display: 'flex', flexDirection: 'column', gap: 2, flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                    <NavItem
                        item={NAV_HOME}
                        currentPath={location.pathname}
                        onNavigate={isMobile ? toggleSidebar : undefined}
                        compacto={compacto}
                        tokens={t}
                    />
                    {NAV_GROUPS.map(group => (
                        <NavGroup
                            key={group.label}
                            group={group}
                            userRole={user?.role}
                            currentPath={location.pathname}
                            openGroups={openGroups}
                            onToggle={toggleGroup}
                            alertCount={alertCount}
                            unmappedCount={unmappedCount}
                            onNavigate={isMobile ? toggleSidebar : undefined}
                            compacto={compacto}
                            tokens={t}
                        />
                    ))}
                </div>

                {/* Usuario */}
                <div style={{
                    padding: 12,
                    borderTop: `1px solid ${t.color.border}`,
                    display: 'flex', flexDirection: compacto ? 'column' : 'row', alignItems: 'center', gap: 10,
                    flexShrink: 0,
                }}>
                    <div title={compacto ? `${displayName} · ${user?.role || ''}` : undefined} style={{
                        width: 32, height: 32, borderRadius: t.radius.full,
                        background: t.color.primarySoft,
                        color: t.color.primary, fontWeight: t.font.weight.semibold, fontSize: 12,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                    }}>
                        {initials}
                    </div>
                    {!compacto && (
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {displayName}
                            </div>
                            <div style={{ fontSize: 11, color: t.color.textFaint }}>{user?.role}</div>
                        </div>
                    )}
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

function getBadgeCount(item, alertCount, unmappedCount) {
    return item.badge ? alertCount : item.unmappedBadge ? unmappedCount : 0;
}

// Grupo plegable: el de la pantalla actual siempre está abierto; los demás recuerdan
// cómo los dejó el usuario. Cerrado, muestra la suma de avisos de sus ítems.
// Comprimido: sin títulos ni pliegues, todos los íconos separados por una línea por grupo.
function NavGroup({ group, userRole, currentPath, openGroups, onToggle, alertCount, unmappedCount, onNavigate, compacto = false, tokens: t }) {
    const [hovered, setHovered] = useState(false);
    const visibleItems = group.items.filter(i => !i.roles || i.roles.includes(userRole));
    if (visibleItems.length === 0) return null;

    if (compacto) {
        return (
            <>
                <div role="separator" title={group.label} style={{ height: 1, background: t.color.border, margin: '8px 6px' }} />
                {visibleItems.map(item => (
                    <NavItem
                        key={item.path}
                        item={item}
                        alertCount={alertCount}
                        unmappedCount={unmappedCount}
                        currentPath={currentPath}
                        onNavigate={onNavigate}
                        compacto
                        tokens={t}
                    />
                ))}
            </>
        );
    }

    const hasActiveItem = visibleItems.some(i => isPathActive(i, currentPath));
    const isOpen = hasActiveItem || !!openGroups[group.label];
    const badgeTotal = visibleItems.reduce((acc, i) => acc + getBadgeCount(i, alertCount, unmappedCount), 0);
    const hasAlert = visibleItems.some(i => i.badge && alertCount > 0);

    return (
        <>
            <button
                type="button"
                onClick={() => onToggle(group.label, isOpen)}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                aria-expanded={isOpen}
                style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', padding: '16px 12px 6px',
                    background: 'transparent', border: 'none',
                    color: hasActiveItem ? t.color.primary : hovered ? t.color.textMuted : t.color.textFaint,
                    fontSize: 11, fontWeight: t.font.weight.semibold,
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    cursor: 'pointer', textAlign: 'left',
                    fontFamily: t.font.family,
                    transition: 'color 120ms',
                }}
            >
                <span style={{ flex: 1 }}>{group.label}</span>
                {!isOpen && badgeTotal > 0 && (
                    <span style={{
                        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
                        padding: '1px 7px', borderRadius: t.radius.full, letterSpacing: 0,
                        background: hasAlert ? t.color.danger : t.color.accentSoft,
                        color: hasAlert ? '#fff' : t.color.accent,
                    }}>
                        {badgeTotal > 99 ? '99+' : badgeTotal}
                    </span>
                )}
                {isOpen
                    ? <Icon.ChevronDown size={12} color="currentColor" />
                    : <Icon.ChevronRight size={12} color="currentColor" />}
            </button>
            {isOpen && visibleItems.map(item => (
                <NavItem
                    key={item.path}
                    item={item}
                    alertCount={alertCount}
                    unmappedCount={unmappedCount}
                    currentPath={currentPath}
                    onNavigate={onNavigate}
                    tokens={t}
                />
            ))}
        </>
    );
}

function NavItem({ item, alertCount = 0, unmappedCount = 0, currentPath, onNavigate, isChild = false, compacto = false, tokens: t }) {
    const [hovered, setHovered] = useState(false);
    const isActive = isPathActive(item, currentPath);
    const badgeCount = getBadgeCount(item, alertCount, unmappedCount);

    // Comprimido: solo el ícono, con el nombre al pasar el mouse y un punto si hay avisos
    if (compacto) {
        return (
            <NavLink to={item.path} style={{ textDecoration: 'none' }} onClick={onNavigate}
                title={badgeCount > 0 ? `${item.label} (${badgeCount})` : item.label} aria-label={item.label}>
                <div
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                    style={{
                        position: 'relative', height: 38, borderRadius: t.radius.sm,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: isActive ? t.color.primarySoft : hovered ? t.color.surface2 : 'transparent',
                        color: isActive ? t.color.primary : t.color.textMuted,
                        transition: 'all 120ms',
                    }}
                >
                    <item.icon size={18} color="currentColor" />
                    {badgeCount > 0 && (
                        <span style={{
                            position: 'absolute', top: 6, right: 10, width: 8, height: 8, borderRadius: t.radius.full,
                            background: item.badge ? t.color.danger : t.color.accent,
                            border: `2px solid ${t.color.surface}`,
                        }} />
                    )}
                </div>
            </NavLink>
        );
    }

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

function BotonCompacto({ compacto, onToggle, tokens: t }) {
    const [hovered, setHovered] = useState(false);
    const texto = compacto ? 'Mostrar el menú completo' : 'Comprimir el menú';
    return (
        <button
            type="button"
            onClick={onToggle}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            title={texto}
            aria-label={texto}
            aria-pressed={compacto}
            style={{
                width: 28, height: 28, borderRadius: t.radius.sm, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: hovered ? t.color.text : t.color.textMuted,
                background: hovered ? t.color.surface2 : 'transparent',
                border: 'none', cursor: 'pointer',
                transition: 'background 120ms',
            }}
        >
            <Icon.PanelLeft size={16} />
        </button>
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
