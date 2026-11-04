// Servidor de prueba de la API del agente: monta solo /api/agente (sin jobs ni scheduler).
// Sirve para probar contra una copia de la base con DATABASE_URL apuntando a ella:
//   DATABASE_URL=postgres://.../neggo_inact_test AGENTE_API_KEY=... node scripts/agentePrueba.js
const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/agente', require('../routes/agente'));
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(422).json({ success: false, error: 'JSON inválido', codigo: 'datos_invalidos' });
    }
    console.error('❌ Prueba agente:', err.message);
    return res.status(500).json({ success: false, error: 'Error interno', codigo: 'error_interno' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`✅ API del agente de prueba en el puerto ${port}`));
