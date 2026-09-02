import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shq, buildNewSessionArgs, target } from '../server/tmux.js';
import { buildWrapperCommand, sessionName } from '../server/chat/tmux-proc.js';

describe('shq', () => {
  test('cadena simple sin comillas', () => {
    assert.equal(shq('hola'), "'hola'");
  });

  test('cadena con comilla simple', () => {
    assert.equal(shq("it's"), "'it'\\''s'");
  });

  test('cadena con varias comillas simples hace roundtrip vía shell', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const input = "'a'b'";
    const quoted = shq(input);
    const { stdout } = await execFileAsync('bash', ['-c', `printf '%s' ${quoted}`]);
    assert.equal(stdout, input);
  });

  test('cadena vacía', () => {
    assert.equal(shq(''), "''");
  });

  test('no permite escapar el envoltorio (roundtrip vía shell)', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const evil = "$(rm -rf /) ; echo pwned && `whoami`";
    const quoted = shq(evil);
    const { stdout } = await execFileAsync('bash', ['-c', `printf '%s' ${quoted}`]);
    assert.equal(stdout, evil);
  });
});

describe('target', () => {
  test('añade "=" de match exacto y ":" final', () => {
    // El ":" es necesario: sin él, comandos que targetean pane (send-keys,
    // capture-pane, copy-mode) interpretan "=id" como un pane exacto llamado
    // "id" y fallan con "can't find pane: =id" (comprobado con tmux 3.7b
    // real). Con ":" el componente exacto es la sesión y deja ventana/pane
    // en su valor por defecto; funciona igual para has-session/kill-session.
    assert.equal(target('agy_foo'), '=agy_foo:');
  });
});

describe('buildNewSessionArgs', () => {
  test('sesión detached con cwd y el comando como una sola cadena', () => {
    const args = buildNewSessionArgs({ id: 'chat-c_1', cwd: '/home/x/proj', command: "'/a/b.sh' 'x'" });
    assert.deepEqual(args, ['new-session', '-d', '-s', 'chat-c_1', '-c', '/home/x/proj', '-x', '200', '-y', '50', '--', "'/a/b.sh' 'x'"]);
  });
});

describe('buildWrapperCommand / sessionName', () => {
  const paths = { fifo: '/d/c_1.in', out: '/d/c_1.out', err: '/d/c_1.err' };

  test('wrapper + fifo/out/err + argv, todo citado con shq', () => {
    const cmd = buildWrapperCommand(paths, ['agy', '-p=', '--add-dir', "/ruta con 'comillas'"]);
    assert.match(cmd, /^'[^']*\/scripts\/chat-agy\.sh' '\/d\/c_1\.in' '\/d\/c_1\.out' '\/d\/c_1\.err' 'agy' '-p=' '--add-dir' '\/ruta con '\\''comillas'\\'''$/);
  });

  test('el comando hace roundtrip por sh -c sin perder argumentos', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const cmd = buildWrapperCommand(paths, ['agy', 'a b', "c'd", '$HOME', '`x`']);
    // sustituimos el wrapper por printf para ver exactamente qué argumentos llegan
    const probe = cmd.replace(/^'[^']*chat-agy\.sh'/, "printf '%s\\n'");
    const { stdout } = await run('sh', ['-c', probe]);
    assert.deepEqual(stdout.split('\n').filter(Boolean), ['/d/c_1.in', '/d/c_1.out', '/d/c_1.err', 'agy', 'a b', "c'd", '$HOME', '`x`']);
  });

  test('sessionName', () => {
    assert.equal(sessionName('c_abc123'), 'chat-c_abc123');
  });
});
