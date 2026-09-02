import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Fichero separado de auth.test.js porque config.js cachea AGY_TOKEN al
// importar; node:test ejecuta cada fichero en su propio proceso, así que este
// escenario (sin token) no interfiere con auth.test.js (con token). Ver la
// nota sobre import() dinámico en auth.test.js: es imprescindible aquí
// también, por el mismo motivo de orden de evaluación en ESM.
delete process.env.AGY_TOKEN;
process.env.AGY_PROJECTS_ROOT = process.env.AGY_PROJECTS_ROOT || '/tmp';

const { isAuthorized } = await import('../server/auth.js');

describe('auth.isAuthorized (sin AGY_TOKEN configurado)', () => {
  test('sin token configurado → siempre true', () => {
    assert.equal(isAuthorized(undefined), true);
    assert.equal(isAuthorized(''), true);
    assert.equal(isAuthorized('cualquier-cosa'), true);
  });
});
