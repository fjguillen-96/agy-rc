import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// IMPORTANTE: en ESM las importaciones estáticas de módulos se evalúan ANTES
// que el resto del cuerpo del fichero (aunque el `import` aparezca después
// textualmente), así que fijar process.env.AGY_TOKEN aquí y luego hacer un
// `import ... from '../server/auth.js'` estático NO funcionaría: config.js ya
// se habría evaluado con AGY_TOKEN vacío. Por eso usamos import() dinámico
// (top-level await), que sí respeta el orden real de ejecución.
process.env.AGY_TOKEN = 'secret-token-123';
process.env.AGY_PROJECTS_ROOT = process.env.AGY_PROJECTS_ROOT || '/tmp';

const { isAuthorized } = await import('../server/auth.js');

describe('auth.isAuthorized (con AGY_TOKEN configurado)', () => {
  test('token correcto → true', () => {
    assert.equal(isAuthorized('secret-token-123'), true);
  });

  test('token incorrecto (misma longitud) → false', () => {
    assert.equal(isAuthorized('secret-token-124'), false);
  });

  test('token de longitud distinta → false', () => {
    assert.equal(isAuthorized('short'), false);
    assert.equal(isAuthorized('a-much-longer-token-than-the-real-one'), false);
  });

  test('token vacío/ausente → false', () => {
    assert.equal(isAuthorized(''), false);
    assert.equal(isAuthorized(undefined), false);
    assert.equal(isAuthorized(null), false);
  });
});
