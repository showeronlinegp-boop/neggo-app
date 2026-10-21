import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import LoadingSpinner from './components/common/LoadingSpinner';
import ErrorBoundary from './components/ErrorBoundary';

// ─── Lazy imports ─────────────────────────────────────────────────────────────
// Páginas ya implementadas
const SupplierList = lazy(() => import('./pages/suppliers/SupplierList'));

// Páginas pendientes de implementación — placeholders funcionales
const SupplierProducts  = lazy(() => import('./pages/products/SupplierProducts'));
const PriceAlerts       = lazy(() => import('./pages/alerts/PriceAlerts'));
const ClientOrders      = lazy(() => import('./pages/preventas/ClientOrders'));
const SupplierOrders    = lazy(() => import('./pages/preventas/SupplierOrders'));
const Catalogs          = lazy(() => import('./pages/preventas/Catalogs'));
const OdooQuotations        = lazy(() => import('./pages/preventas/OdooQuotations'));
const PricelistManager      = lazy(() => import('./pages/preventas/PricelistManager'));
const OdooSupplierBreakdown = lazy(() => import('./pages/preventas/OdooSupplierBreakdown'));
const PreventasSyncPage     = lazy(() => import('./pages/preventas/PreventasSyncPage'));
const ProductMappings   = lazy(() => import('./pages/products/ProductMappings'));
const SupplierRules     = lazy(() => import('./pages/suppliers/SupplierRules'));
const ScrapingPanel     = lazy(() => import('./pages/scraping/ScrapingPanel'));
const IngresoList       = lazy(() => import('./pages/IngresoList'));
const IngresoUpload     = lazy(() => import('./pages/IngresoUpload'));
const IngresoPreview    = lazy(() => import('./pages/IngresoPreview'));
const Users             = lazy(() => import('./pages/admin/Users'));
const ActivityLog       = lazy(() => import('./pages/admin/ActivityLog'));
const AdminPanel        = lazy(() => import('./pages/admin/AdminPanel'));
const OdooProducts      = lazy(() => import('./pages/admin/OdooProducts'));
const WhatsAppPublish   = lazy(() => import('./pages/admin/WhatsAppPublish'));
const Reposicion        = lazy(() => import('./pages/reposicion/Reposicion'));
const Recorrida         = lazy(() => import('./pages/reposicion/Recorrida'));
const PedidoEnvios      = lazy(() => import('./pages/pedidos/PedidoEnvios'));
const PedidoEnvioDetalle = lazy(() => import('./pages/pedidos/PedidoEnvioDetalle'));
const Clientes          = lazy(() => import('./pages/clientes/Clientes'));
const MiDia             = lazy(() => import('./pages/clientes/MiDia'));

// ─── Fallback de carga ────────────────────────────────────────────────────────
function PageLoader() {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
            <LoadingSpinner size="lg" />
        </div>
    );
}

// ─── App ───────────────────────────────────────────────────────────────────────
export default function App() {
    return (
        <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
            <Routes>
                {/* Ruta pública */}
                <Route path="/login" element={<Login />} />

                {/* Rutas protegidas */}
                <Route element={<ProtectedRoute />}>
                    <Route element={<Layout />}>
                        {/* Dashboard */}
                        <Route path="/"                        element={<Dashboard />} />

                        {/* Productos */}
                        <Route path="/productos"               element={<SupplierProducts />} />
                        <Route path="/productos/vinculos"      element={<ProductMappings />} />

                        {/* Ventas */}
                        <Route path="/clientes"                element={<Clientes />} />
                        <Route path="/clientes/mi-dia"         element={<MiDia />} />

                        {/* Alertas */}
                        <Route path="/alertas"                 element={<PriceAlerts />} />

                        {/* Preventas */}
                        <Route path="/preventas/pedidos"       element={<ClientOrders />} />
                        <Route path="/preventas/ordenes"       element={<SupplierOrders />} />
                        <Route path="/preventas/catalogos"     element={<Catalogs />} />
                        <Route path="/preventas/cotizaciones"  element={<OdooQuotations />} />
                        <Route path="/preventas/listas-precios" element={<PricelistManager />} />
                        <Route path="/preventas/ordenes-odoo"  element={<OdooSupplierBreakdown />} />

                        {/* Productos — gestión avanzada */}
                        <Route path="/productos/sync-preventas" element={<PreventasSyncPage />} />

                        {/* Solo admin */}
                        <Route path="/proveedores"             element={<SupplierList />} />
                        <Route path="/proveedores/:id/reglas"  element={<SupplierRules />} />
                        <Route path="/scraping"                element={<ScrapingPanel />} />
                        <Route path="/ingreso"                 element={<IngresoList />} />
                        <Route path="/ingreso/new"             element={<IngresoUpload />} />
                        <Route path="/ingreso/:ingresoId"      element={<IngresoPreview />} />
                        <Route path="/reposicion"              element={<Reposicion />} />
                        <Route path="/reposicion/recorrida"    element={<Recorrida />} />
                        <Route path="/pedidos/armado"          element={<PedidoEnvios />} />
                        <Route path="/pedidos/armado/:id"      element={<PedidoEnvioDetalle />} />
                        <Route path="/admin"                    element={<AdminPanel />} />
                        <Route path="/admin/odoo-products"     element={<OdooProducts />} />
                        <Route path="/admin/whatsapp"          element={<WhatsAppPublish />} />
                        <Route path="/usuarios"                element={<Users />} />
                        <Route path="/actividad"               element={<ActivityLog />} />

                        {/* Fallback: redirigir a raíz */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Route>
                </Route>
            </Routes>
        </Suspense>
        </ErrorBoundary>
    );
}
