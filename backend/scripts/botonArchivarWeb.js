// Botón "Archivar producto" en la tienda web de Odoo (los 3 sitios), solo para
// administradores de Odoo (Ajustes / base.group_system). Son dos vistas:
//   - ficha de producto (website_sale.product): botón arriba del nombre
//   - layout del sitio (website.layout): script que hace andar el botón de la ficha
//     y suma un botón chico en la lista de la lupita, en la página de resultados
//     (Enter en la lupita) y en la grilla de /shop
// El script y los botones solo se dibujan para admins. Archiva el product.template
// con la sesión del admin vía JSON-RPC, así que Odoo vuelve a chequear permisos.
// Al archivarse, el sync de Neggo lo detecta y lo manda a la cola de Reposición.
//
// OJO: el JS va dentro de XML que Odoo re-serializa: no usar los caracteres
// menor, mayor ni ampersand (ni flechas =>, ni &&, ni comparaciones con < >).
//
//   node scripts/botonArchivarWeb.js            → muestra si está instalado
//   node scripts/botonArchivarWeb.js instalar   → crea o actualiza las vistas
//   node scripts/botonArchivarWeb.js quitar     → borra las vistas (vuelve todo como estaba)

const { callOdoo } = require('../config/odoo');

const ES_ADMIN = "request.env.user.has_group('base.group_system')";

const SCRIPT = `
(function () {
    var conf = document.currentScript;
    var companias = (conf.dataset.companias || '').split(',').filter(Boolean).map(Number);

    function idDesde(a) {
        var href = a ? (a.getAttribute('href') || '') : '';
        if (href.indexOf('/shop/') !== 0 || href.indexOf('/shop/category/') === 0) { return null; }
        var m = /-(\\d+)(?:[?#].*)?$/.exec(href);
        return m ? Number(m[1]) : null;
    }

    function crearBoton(id, nombre, conTexto) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm btn-outline-danger bg-white o_neggo_btn_archivar';
        b.dataset.tmplId = id;
        b.dataset.nombre = nombre;
        b.title = 'Archivar producto (solo lo ven los administradores)';
        var i = document.createElement('i');
        i.className = 'fa fa-archive';
        b.appendChild(i);
        if (conTexto) { b.appendChild(document.createTextNode(' Archivar')); }
        return b;
    }

    function marcar() {
        if (document.body.classList.contains('editor_enable')) { return; }
        // Lista de la lupita y página de resultados de /website/search
        document.querySelectorAll('.o_search_result_item').forEach(function (item) {
            if (item.dataset.neggoArch) { return; }
            item.dataset.neggoArch = '1';
            var id = idDesde(item.closest('a'));
            if (!id) { return; }
            var titulo = item.querySelector('.h6') || item;
            var b = crearBoton(id, titulo.textContent.trim(), false);
            b.classList.add('ms-2', 'flex-shrink-0');
            item.appendChild(b);
        });
        // Grilla de /shop (también al buscar desde la tienda)
        document.querySelectorAll('form.oe_product_cart').forEach(function (card) {
            if (card.dataset.neggoArch) { return; }
            card.dataset.neggoArch = '1';
            var id = idDesde(card.querySelector('a.oe_product_image_link') || card.querySelector('a[href^="/shop/"]'));
            if (!id) { return; }
            var b = crearBoton(id, card.getAttribute('aria-label') || '', false);
            b.style.position = 'absolute';
            b.style.top = '6px';
            b.style.left = '6px';
            b.style.zIndex = '5';
            var foto = card.querySelector('.oe_product_image') || card;
            foto.appendChild(b);
        });
    }

    function quitarDeLaLista(b) {
        var fila = b.closest('a.dropdown-item') || b.closest('.oe_product') || b.closest('form.oe_product_cart');
        if (fila) { fila.remove(); }
    }

    function rpc(method, args) {
        return fetch('/web/dataset/call_kw/product.template/' + method, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                jsonrpc: '2.0', method: 'call', id: Date.now(),
                params: {
                    model: 'product.template', method: method, args: args,
                    kwargs: { context: { allowed_company_ids: companias } }
                }
            })
        }).then(function (r) { return r.json(); }).then(function (res) {
            if (res.error) { throw new Error((res.error.data || {}).message || res.error.message); }
            return res.result;
        });
    }

    function archivar(b) {
        if (b.disabled) { return; }
        var nombre = b.dataset.nombre;
        var id = Number(b.dataset.tmplId);
        if (!window.confirm('¿Archivar «' + nombre + '»?\\n\\nLo saca del PdV, deja de verse en la web y en Odoo pasa a archivados.')) { return; }
        b.disabled = true;
        var sacadoDelPdv = false;
        // Odoo no deja archivar algo disponible en el PdV con sesiones abiertas:
        // primero se saca del PdV (igual que hace la app) y después se archiva.
        rpc('read', [[id], ['available_in_pos']]).then(function (filas) {
            if (!filas.length || !filas[0].available_in_pos) { return null; }
            return rpc('write', [[id], { available_in_pos: false }]).then(function () { sacadoDelPdv = true; });
        }).then(function () {
            return rpc('action_archive', [[id]]);
        }).then(function () {
            if (b.closest('.o_neggo_archivar')) {
                window.alert('Listo: «' + nombre + '» quedó archivado.');
                window.location.href = '/shop';
            } else {
                quitarDeLaLista(b);
            }
        }).catch(function (err) {
            // Si no se pudo archivar, que vuelva a estar en el PdV como antes
            var volver = sacadoDelPdv
                ? rpc('write', [[id], { available_in_pos: true }]).catch(function () { return null; })
                : Promise.resolve();
            volver.then(function () {
                window.alert('No se pudo archivar «' + nombre + '»: ' + err.message);
                b.disabled = false;
            });
        });
    }

    // mousedown sin default: que la lupita no pierda el foco y no se cierre la lista
    document.addEventListener('mousedown', function (e) {
        if (e.target.closest('.o_neggo_btn_archivar')) { e.preventDefault(); }
    }, true);
    // En captura: frena el link del resultado antes de que navegue
    document.addEventListener('click', function (e) {
        var b = e.target.closest('.o_neggo_btn_archivar');
        if (!b) { return; }
        e.preventDefault();
        e.stopPropagation();
        archivar(b);
    }, true);

    var pendiente = null;
    new MutationObserver(function () {
        if (pendiente) { return; }
        pendiente = setTimeout(function () { pendiente = null; marcar(); }, 60);
    }).observe(document.body, { childList: true, subtree: true });
    marcar();
})();
`;

const VISTAS = [
    {
        key: 'neggo_app.boton_archivar_producto_web',
        padre: 'website_sale.product',
        name: 'Neggo App: botón Archivar en la ficha (solo admins)',
        arch: `<data>
    <xpath expr="//div[@id='o_wsale_product_details_content']/*[1]" position="before">
        <div t-if="${ES_ADMIN}" class="o_neggo_archivar css_editable_mode_hidden o_not_editable mb-3 d-flex align-items-center gap-2">
            <button type="button" class="btn btn-sm btn-outline-danger o_neggo_btn_archivar"
                    t-att-data-tmpl-id="product.id" t-att-data-nombre="product.name">
                <i class="fa fa-archive me-1"/>Archivar producto
            </button>
            <small class="text-muted">Solo lo ven los administradores</small>
        </div>
    </xpath>
</data>`
    },
    {
        key: 'neggo_app.boton_archivar_script_web',
        padre: 'website.layout',
        name: 'Neggo App: script de Archivar en la tienda (solo admins)',
        arch: `<data>
    <xpath expr="//div[@id='wrapwrap']" position="after">
        <script t-if="${ES_ADMIN}"
                t-att-data-companias="','.join(str(c) for c in request.env.user.company_ids.ids)">${SCRIPT}</script>
    </xpath>
</data>`
    }
];

async function buscarVistas(key) {
    return callOdoo('ir.ui.view', 'search_read', [[['key', '=', key]]], {
        fields: ['id', 'active'], context: { active_test: false }
    });
}

async function main() {
    const comando = process.argv[2] || 'estado';
    if (!['estado', 'instalar', 'quitar'].includes(comando)) {
        throw new Error(`Comando desconocido: ${comando} (usá estado, instalar o quitar)`);
    }

    for (const vista of VISTAS) {
        const existentes = await buscarVistas(vista.key);
        const ids = existentes.map(v => v.id);

        if (comando === 'estado') {
            console.log(ids.length
                ? `📦 ${vista.key}: instalada (${ids.join(', ')})`
                : `📦 ${vista.key}: no está instalada`);
            continue;
        }

        if (comando === 'quitar') {
            if (ids.length) await callOdoo('ir.ui.view', 'unlink', [ids]);
            console.log(ids.length ? `✅ ${vista.key}: borrada (${ids.join(', ')})` : `📦 ${vista.key}: no había nada`);
            continue;
        }

        const padres = await callOdoo('ir.ui.view', 'search_read',
            [[['key', '=', vista.padre], ['website_id', '=', false]]], { fields: ['id'] });
        if (!padres.length) throw new Error(`No encontré la vista ${vista.padre} en Odoo`);
        const valores = {
            name: vista.name, key: vista.key, type: 'qweb', mode: 'extension',
            inherit_id: padres[0].id, arch_db: vista.arch, active: true, priority: 99
        };
        if (ids.length) {
            await callOdoo('ir.ui.view', 'write', [ids, valores]);
            console.log(`✅ ${vista.key}: actualizada (${ids.join(', ')})`);
        } else {
            const id = await callOdoo('ir.ui.view', 'create', [valores]);
            console.log(`✅ ${vista.key}: creada (id ${id}) sobre ${vista.padre} (${padres[0].id})`);
        }
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('❌', err.message);
        process.exit(1);
    });
}

module.exports = { SCRIPT, VISTAS };
