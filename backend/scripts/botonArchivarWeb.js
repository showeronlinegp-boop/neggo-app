// Botón "Archivar producto" en la ficha de la tienda web de Odoo (los 3 sitios).
// Es una vista heredada de website_sale.product: solo se dibuja si quien mira es
// administrador de Odoo (Ajustes). Archiva con la sesión del admin vía JSON-RPC,
// así que Odoo vuelve a chequear permisos del lado del servidor.
// Al archivarse, el sync de Neggo lo detecta y lo manda a la cola de Reposición.
//
//   node scripts/botonArchivarWeb.js            → muestra si está instalado
//   node scripts/botonArchivarWeb.js instalar   → crea o actualiza la vista
//   node scripts/botonArchivarWeb.js quitar     → borra la vista (vuelve todo como estaba)

const { callOdoo } = require('../config/odoo');

const KEY = 'neggo_app.boton_archivar_producto_web';
const PADRE = 'website_sale.product';

const ARCH = `<data>
    <xpath expr="//div[@id='o_wsale_product_details_content']/*[1]" position="before">
        <t t-if="request.env.user.has_group('base.group_system')">
            <div class="o_neggo_archivar css_editable_mode_hidden o_not_editable mb-3 d-flex align-items-center gap-2">
                <button type="button" class="btn btn-sm btn-outline-danger o_neggo_btn_archivar"
                        t-att-data-tmpl-id="product.id"
                        t-att-data-nombre="product.name"
                        t-att-data-companias="','.join(str(c) for c in request.env.user.company_ids.ids)">
                    <i class="fa fa-archive me-1"/>Archivar producto
                </button>
                <small class="text-muted">Solo lo ven los administradores</small>
            </div>
            <script>
                (function () {
                    var btn = document.querySelector('.o_neggo_btn_archivar');
                    if (!btn || btn.dataset.listo) { return; }
                    btn.dataset.listo = '1';
                    btn.addEventListener('click', function () {
                        var nombre = btn.dataset.nombre;
                        if (!window.confirm('¿Archivar «' + nombre + '»?\\n\\nDeja de verse en la web y en Odoo pasa a archivados.')) { return; }
                        btn.disabled = true;
                        btn.textContent = 'Archivando…';
                        var companias = (btn.dataset.companias || '').split(',').filter(Boolean).map(Number);
                        fetch('/web/dataset/call_kw/product.template/action_archive', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'same-origin',
                            body: JSON.stringify({
                                jsonrpc: '2.0', method: 'call', id: Date.now(),
                                params: {
                                    model: 'product.template', method: 'action_archive',
                                    args: [[Number(btn.dataset.tmplId)]],
                                    kwargs: { context: { allowed_company_ids: companias } }
                                }
                            })
                        }).then(function (r) { return r.json(); }).then(function (res) {
                            if (res.error) {
                                var msg = (res.error.data || {}).message || res.error.message;
                                throw new Error(msg);
                            }
                            window.alert('Listo: «' + nombre + '» quedó archivado.');
                            window.location.href = '/shop';
                        }).catch(function (err) {
                            window.alert('No se pudo archivar: ' + err.message);
                            btn.disabled = false;
                            btn.textContent = 'Archivar producto';
                        });
                    });
                })();
            </script>
        </t>
    </xpath>
</data>`;

async function buscarVista() {
    const vistas = await callOdoo('ir.ui.view', 'search_read', [[['key', '=', KEY]]], {
        fields: ['id', 'active', 'website_id'], context: { active_test: false }
    });
    return vistas;
}

async function main() {
    const comando = process.argv[2] || 'estado';
    const vistas = await buscarVista();

    if (comando === 'estado') {
        console.log(vistas.length
            ? `📦 Instalado: vista(s) ${vistas.map(v => `${v.id}${v.active ? '' : ' (inactiva)'}`).join(', ')}`
            : '📦 No está instalado');
        return;
    }

    if (comando === 'instalar') {
        const padres = await callOdoo('ir.ui.view', 'search_read', [[['key', '=', PADRE], ['website_id', '=', false]]], { fields: ['id'] });
        if (!padres.length) throw new Error(`No encontré la vista ${PADRE} en Odoo`);
        const valores = {
            name: 'Neggo App: botón Archivar producto (solo admins)',
            key: KEY, type: 'qweb', mode: 'extension',
            inherit_id: padres[0].id, arch_db: ARCH, active: true, priority: 99
        };
        if (vistas.length) {
            await callOdoo('ir.ui.view', 'write', [vistas.map(v => v.id), valores]);
            console.log(`✅ Vista actualizada (${vistas.map(v => v.id).join(', ')})`);
        } else {
            const id = await callOdoo('ir.ui.view', 'create', [valores]);
            console.log(`✅ Vista creada (id ${id}) sobre ${PADRE} (${padres[0].id})`);
        }
        return;
    }

    if (comando === 'quitar') {
        if (!vistas.length) { console.log('📦 No había nada para quitar'); return; }
        await callOdoo('ir.ui.view', 'unlink', [vistas.map(v => v.id)]);
        console.log(`✅ Vista borrada (${vistas.map(v => v.id).join(', ')})`);
        return;
    }

    throw new Error(`Comando desconocido: ${comando} (usá estado, instalar o quitar)`);
}

main().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
});
