// Armado de términos y códigos para las sugerencias de vinculación. Sin base.
// node backend/services/linkSuggestion.test.js

const assert = require('assert');
const { normalizeCode, searchTerms, codeFamily, normText } = require('./linkSuggestionService');

function testNormalizeCode() {
    assert.strictEqual(normalizeCode('mg-br 8003021'), 'MGBR8003021');
    assert.strictEqual(normalizeCode(null), '');
}

function testSearchTerms() {
    // Sin acentos, sin palabras vacías, sin repetidas, en cualquier orden
    assert.deepStrictEqual(searchTerms('Broche ACRÍLICO c/ dije de broche'), ['broche', 'acrilico', 'dije']);
    assert.deepStrictEqual(searchTerms('  '), []);
    assert.strictEqual(searchTerms('a b c d e f g h i j kk ll mm nn oo pp qq').length <= 6, true);
    assert.strictEqual(normText('Jabón'), 'jabon');
}

function testCodeFamily() {
    assert.strictEqual(codeFamily('CL2274982'), 'CL227498');
    // Códigos cortos dan demasiados parecidos
    assert.strictEqual(codeFamily('CL0005'), null);
    // Si no termina en número no hay variante
    assert.strictEqual(codeFamily('ABCDEFGH'), null);
}

testNormalizeCode();
testSearchTerms();
testCodeFamily();
console.log('✅ linkSuggestion: todos los tests pasaron');
