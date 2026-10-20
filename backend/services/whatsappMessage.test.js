// Ningún mensaje sale sin texto o sin foto, y el link de la web se arma bien.
// Sin red ni base: node backend/services/whatsappMessage.test.js

const assert = require('assert');
const { assertSendable, detectMime, productLink, withLink, EmptyMessageError } = require('./whatsappMessage');
const { attachLinks, toProduct } = require('./whatsappRandom');
const evolution = require('./evolutionClient');

const pad = Buffer.alloc(400);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pad]).toString('base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), pad]).toString('base64');

function rejects(msg, pattern) {
    assert.throws(() => assertSendable(msg), (err) => err instanceof EmptyMessageError && pattern.test(err.message));
}

function testEmpty() {
    // Sin texto
    rejects({ caption: '', base64: JPEG }, /sin texto/);
    rejects({ caption: '   \n\t ', base64: JPEG }, /sin texto/);
    rejects({ caption: null, base64: JPEG }, /sin texto/);
    rejects({ caption: '\n- . -\n', base64: JPEG }, /sin texto/);
    // Sin foto
    rejects({ caption: 'Mate $1.500', base64: '' }, /sin foto/);
    rejects({ caption: 'Mate $1.500', base64: undefined }, /sin foto/);
    rejects({ caption: 'Mate $1.500', base64: 'no es base64 !!' }, /sin foto/);
    rejects({ caption: 'Mate $1.500', base64: 'aG9sYQ==' }, /vacía o rota/);
    rejects({ caption: 'Mate $1.500', base64: Buffer.alloc(500).toString('base64') }, /no es una foto/);
    // Sin nada
    rejects({ caption: '', base64: '' }, /sin texto/);
    console.log('mensajes vacíos bloqueados ok');
}

function testValid() {
    const ok = assertSendable({ caption: '  Mate\n$1.500  ', base64: `data:image/png;base64,${PNG}` });
    assert.strictEqual(ok.caption, 'Mate\n$1.500');
    assert.strictEqual(ok.mimetype, 'image/png');
    assert.strictEqual(ok.base64, PNG);
    assert.strictEqual(detectMime(Buffer.from(JPEG, 'base64')), 'image/jpeg');
    assert.strictEqual(detectMime(Buffer.from(WEBP, 'base64')), 'image/webp');
    console.log('mensajes válidos ok');
}

async function testEvolutionGuard() {
    // sendImage corta antes de llamar a la red.
    const prevFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; throw new Error('no debería llamar'); };
    process.env.EVOLUTION_API_KEY = 'x';
    try {
        await assert.rejects(evolution.sendImage({ number: '1@g.us', caption: ' ', base64: JPEG }), /sin texto/);
        await assert.rejects(evolution.sendImage({ number: '1@g.us', caption: 'Mate', base64: '' }), /sin foto/);
        await assert.rejects(evolution.sendImage({ number: '', caption: 'Mate', base64: JPEG }), /destino/);
        assert.strictEqual(called, false);
        let body = null;
        global.fetch = async (url, init) => {
            body = JSON.parse(init.body);
            return { ok: true, text: async () => JSON.stringify({ key: { id: 'evo-9' } }) };
        };
        const id = await evolution.sendImage({ number: '1@g.us', caption: 'Mate\n$1.500', base64: WEBP });
        assert.strictEqual(id, 'evo-9');
        assert.strictEqual(body.mimetype, 'image/webp');
        assert.strictEqual(body.caption, 'Mate\n$1.500');
    } finally {
        global.fetch = prevFetch;
    }
    console.log('evolution no manda vacíos ok');
}

function testCommunityGroups() {
    const groups = evolution.normalizeGroups([
        { id: '120363218543511311@g.us', subject: 'Neggo Polirrubros', isCommunity: true, size: 2 },
        { id: '120363218295245705@g.us', subject: 'Neggo Polirrubros', isCommunityAnnounce: true, size: 361 },
        { id: '120363221405263046@g.us', subject: 'Chat', size: 177 },
    ]);
    assert.deepStrictEqual(groups.map((g) => g.jid), ['120363218295245705@g.us', '120363221405263046@g.us']);
    assert.strictEqual(groups[0].subject, 'Neggo Polirrubros (avisos de la comunidad)');
    console.log('comunidades ok');
}

async function testLinks() {
    assert.strictEqual(productLink('/shop/mate-12', 'https://neggo.odoo.com/'), 'https://neggo.odoo.com/shop/mate-12');
    assert.strictEqual(productLink('', 'https://neggo.odoo.com'), null);
    assert.strictEqual(productLink('/shop/x', ''), null);
    assert.strictEqual(withLink('Mate\n$1.500', null), 'Mate\n$1.500');

    process.env.ODOO_URL = 'https://neggo.odoo.com';
    const base = [
        toProduct({ odoo_id: 1, company: 'neggo', name: 'Mate', categ_name: 'Bazar', template_id: 10, list_price: '1499.2' }),
        toProduct({ odoo_id: 2, company: 'neggo', name: 'Termo', categ_name: 'Bazar', template_id: 11, list_price: 2000 }),
    ];
    assert.strictEqual(base[0].caption, 'Mate\n$1.500');
    const linked = await attachLinks(base, 'neggo', async () => new Map([[10, '/shop/mate-10'], [11, false]]));
    assert.strictEqual(linked[0].caption, 'Mate\n$1.500\nhttps://neggo.odoo.com/shop/mate-10');
    assert.strictEqual(linked[0].url, 'https://neggo.odoo.com/shop/mate-10');
    assert.strictEqual(linked[1].caption, 'Termo\n$2.000');
    assert.strictEqual(linked[1].url, null);
    await assert.rejects(attachLinks(base, 'neggo', async () => { throw new Error('timeout'); }), /links de Odoo/);
    assert.strictEqual(toProduct({ odoo_id: 3, company: 'neggo', name: '   ', template_id: 1, list_price: 10 }), null);
    console.log('links ok');
}

function testContactJids() {
    assert.deepStrictEqual(evolution.contactJidsFrom([
        { remoteJid: '549111@s.whatsapp.net' },
        { remoteJid: '120363@g.us' },
        { id: '549111@s.whatsapp.net' },
        { remoteJid: 'status@broadcast' },
        { id: '549222@s.whatsapp.net' },
    ]), ['549111@s.whatsapp.net', '549222@s.whatsapp.net']);
    assert.deepStrictEqual(evolution.detailFromEvolution(
        { error: 'Bad Request', response: { message: ['statusJidList must contain at least 1 elements'] } },
        '',
        'Bad Request'
    ), 'statusJidList must contain at least 1 elements');
    console.log('contactos y errores de evolution ok');
}

async function testSendStatusUsesContacts() {
    const prevFetch = global.fetch;
    process.env.EVOLUTION_API_KEY = 'x';
    process.env.EVOLUTION_INSTANCE = 'neggo';
    process.env.EVOLUTION_STATUS_INSTANCE = 'neggo-estados';
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
        if (String(url).includes('findContacts')) {
            return {
                ok: true,
                text: async () => JSON.stringify([
                    { remoteJid: '549111@s.whatsapp.net' },
                    { remoteJid: '120363@g.us' },
                ]),
            };
        }
        return { ok: true, text: async () => JSON.stringify({ key: { id: 'st-1' } }) };
    };
    try {
        const id = await evolution.sendStatus({ caption: 'Mate\n$1.500', base64: JPEG });
        assert.strictEqual(id, 'st-1');
        assert.ok(calls[0].url.includes('findContacts/neggo-estados'));
        assert.ok(calls[1].url.includes('sendStatus/neggo-estados'));
        assert.deepStrictEqual(calls[1].body.statusJidList, ['549111@s.whatsapp.net']);
        assert.strictEqual(calls[1].body.allContacts, false);
        assert.ok(String(calls[1].body.content).startsWith('data:image/jpeg;base64,'));
    } finally {
        global.fetch = prevFetch;
    }

    global.fetch = async (url) => {
        if (String(url).includes('findContacts')) {
            return { ok: true, text: async () => '[]' };
        }
        throw new Error('no debería mandar el estado');
    };
    try {
        await assert.rejects(
            evolution.sendStatus({ caption: 'Mate\n$1.500', base64: JPEG }),
            /no tiene contactos/
        );
    } finally {
        global.fetch = prevFetch;
    }
    console.log('sendStatus usa contactos ok');
}

(async () => {
    testEmpty();
    testValid();
    await testEvolutionGuard();
    testCommunityGroups();
    await testLinks();
    testContactJids();
    await testSendStatusUsesContacts();
    console.log('✅ whatsappMessage.test ok');
})().catch((err) => {
    console.error('❌', err);
    process.exit(1);
});
