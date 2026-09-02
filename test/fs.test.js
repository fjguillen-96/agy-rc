// test/fs.test.js
// Lo que queda de sessions.js tras eliminar el modo terminal: validación de rutas/nombres
// y el navegador de carpetas de AGY_PROJECTS_ROOT (server/sessions.js).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let projectsRoot;
let slugify;
let validateCwd;
let HttpError;
let createDir;

before(async () => {
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-rc-fs-test-'));
  await fs.mkdir(path.join(projectsRoot, 'proyecto-a'));
  await fs.mkdir(path.join(projectsRoot, 'proyecto-b', 'sub'), { recursive: true });
  await fs.writeFile(path.join(projectsRoot, 'un-fichero.txt'), 'hola');

  process.env.AGY_PROJECTS_ROOT = projectsRoot;
  process.env.AGY_DATA_DIR = path.join(projectsRoot, '.data');
  process.env.AGY_TMUX_SOCKET = 'agyrc-unused-in-unit-tests';

  ({ slugify, validateCwd, HttpError, createDir } = await import('../server/sessions.js'));
});

after(async () => {
  await fs.rm(projectsRoot, { recursive: true, force: true });
});

describe('slugify', () => {
  test('minúsculas y espacios a guiones', () => {
    assert.equal(slugify('Mi Proyecto Genial'), 'mi-proyecto-genial');
  });

  test('guion bajo a guion', () => {
    assert.equal(slugify('mi_proyecto_x'), 'mi-proyecto-x');
  });

  test('quita caracteres no [a-z0-9-]', () => {
    assert.equal(slugify('Café con Ñ! #42'), 'caf-con-42');
  });

  test('colapsa guiones repetidos', () => {
    assert.equal(slugify('a---b   c'), 'a-b-c');
  });

  test('recorta a 32 caracteres', () => {
    const long = 'a'.repeat(50);
    const out = slugify(long);
    assert.equal(out.length, 32);
    assert.equal(out, 'a'.repeat(32));
  });

  test('lanza HttpError 400 si el resultado es vacío', () => {
    assert.throws(() => slugify('!!!'), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      return true;
    });
    assert.throws(() => slugify(''), HttpError);
    assert.throws(() => slugify('   '), HttpError);
  });
});

describe('validateCwd', () => {
  test('acepta la raíz de proyectos', async () => {
    const resolved = await validateCwd('.');
    assert.equal(resolved, projectsRoot);
  });

  test('acepta un subdirectorio directo', async () => {
    const resolved = await validateCwd('proyecto-a');
    assert.equal(resolved, path.join(projectsRoot, 'proyecto-a'));
  });

  test('acepta un subdirectorio anidado', async () => {
    const resolved = await validateCwd('proyecto-b/sub');
    assert.equal(resolved, path.join(projectsRoot, 'proyecto-b', 'sub'));
  });

  test('rechaza ".." que escapa de projectsRoot', async () => {
    await assert.rejects(validateCwd('../../etc'), HttpError);
  });

  test('acepta rutas absolutas existentes fuera de projectsRoot', async () => {
    const tmp = os.tmpdir();
    const resolved = await validateCwd(tmp);
    assert.equal(resolved, tmp);
  });

  test('rechaza un fichero (no es directorio)', async () => {
    await assert.rejects(validateCwd('un-fichero.txt'), HttpError);
  });

  test('rechaza un directorio inexistente', async () => {
    await assert.rejects(validateCwd('no-existe'), HttpError);
  });
});

describe('createDir', () => {
  test('crea carpeta en la raíz y devuelve ruta relativa', async () => {
    const r = await createDir({ parent: '', name: 'nuevo-proyecto' });
    assert.equal(r.path, 'nuevo-proyecto');
    const st = await fs.stat(path.join(projectsRoot, 'nuevo-proyecto'));
    assert.ok(st.isDirectory());
  });
  test('crea subcarpeta con git init', async () => {
    const r = await createDir({ parent: 'proyecto-a', name: 'con-git', git: true });
    assert.equal(r.path, path.join('proyecto-a', 'con-git'));
    const st = await fs.stat(path.join(projectsRoot, 'proyecto-a', 'con-git', '.git')).catch(() => null);
    assert.ok(st, 'debe existir .git (git instalado en el sistema)');
  });
  test('409 si ya existe', async () => {
    await assert.rejects(createDir({ parent: '', name: 'proyecto-a' }), (e) => e instanceof HttpError && e.status === 409);
  });
  test('400 nombres inválidos', async () => {
    for (const bad of ['.oculta', 'con espacio', '../fuera', 'a/b', '']) {
      await assert.rejects(createDir({ parent: '', name: bad }), (e) => e instanceof HttpError && e.status === 400, bad);
    }
  });
  test('400 si parent está fuera de la raíz', async () => {
    await assert.rejects(createDir({ parent: '../..', name: 'x' }), (e) => e instanceof HttpError && e.status === 400);
  });
});
