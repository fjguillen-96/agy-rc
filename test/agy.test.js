import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsOutput, parseAgyStatus, resolveModelId, setModelsCacheForTests, resetModelsCache } from '../server/agy.js';

describe('parseModelsOutput', () => {
  test('salida real de agy models (1.1.23)', () => {
    const out = parseModelsOutput(
      'Fetching available models...\n' +
        'gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n' +
        'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n' +
        'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n' +
        'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'
    );
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)', family: 'Gemini 3.7 Flash', effort: 'high' });
    assert.deepEqual(out[2], { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', family: 'Claude Sonnet 4.6 (Thinking)', effort: null });
    assert.equal(out[3].family, 'GPT-OSS 120B');
  });
  test('vacío → []', () => {
    assert.deepEqual(parseModelsOutput(''), []);
  });
});

describe('parseAgyStatus', () => {
  const pad = ' '.repeat(60);
  test('modo normal', () => {
    assert.deepEqual(parseAgyStatus('> \n? for shortcuts' + pad + 'Gemini 3.7 Flash · medium\n\n'), {
      mode: 'normal', model: 'Gemini 3.7 Flash', effort: 'medium',
    });
  });
  test('modo plan (con tabulador como en tmux)', () => {
    assert.deepEqual(parseAgyStatus('? for shortcuts' + pad + '\t          plan · Gemini 3.1 Pro · high'), {
      mode: 'plan', model: 'Gemini 3.1 Pro', effort: 'high',
    });
  });
  test('modo accept-edits', () => {
    assert.equal(parseAgyStatus('? for shortcuts' + pad + 'accept-edits · Gemini 3.1 Pro · high').mode, 'accept-edits');
  });
  test('menú abierto (esc to cancel)', () => {
    assert.deepEqual(parseAgyStatus('esc to cancel' + pad + 'Claude Sonnet 4.6 (Thinking) · low'), {
      mode: 'normal', model: 'Claude Sonnet 4.6 (Thinking)', effort: 'low',
    });
  });
  test('pantalla de shell → null', () => {
    assert.equal(parseAgyStatus('[user@server project]$ ls\nREADME.md\n'), null);
    assert.equal(parseAgyStatus(''), null);
  });
});

describe('resolveModelId', () => {
  const catalog = parseModelsOutput(
    'gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n' +
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n' +
      'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n' +
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n'
  );

  test('cambia a la variante de la misma familia con el esfuerzo pedido', async () => {
    setModelsCacheForTests(catalog);
    assert.equal(await resolveModelId('gemini-3.7-flash-medium', 'high'), 'gemini-3.7-flash-high');
    assert.equal(await resolveModelId('gemini-3.7-flash-medium', 'medium'), 'gemini-3.7-flash-medium');
    resetModelsCache();
  });

  test('sin variante para ese esfuerzo, o sin esfuerzo en el id, devuelve el id tal cual', async () => {
    setModelsCacheForTests(catalog);
    assert.equal(await resolveModelId('gemini-3.1-pro-high', 'medium'), 'gemini-3.1-pro-high');
    assert.equal(await resolveModelId('claude-sonnet-4-6', 'low'), 'claude-sonnet-4-6');
    assert.equal(await resolveModelId('modelo-desconocido', 'low'), 'modelo-desconocido');
    assert.equal(await resolveModelId(null, 'low'), null);
    resetModelsCache();
  });
});

describe('build.js', () => {
  test('computeBuildId es estable y renderServiceWorker inyecta el build en CACHE_NAME', async () => {
    const { computeBuildId, renderServiceWorker } = await import('../server/build.js');
    const a = computeBuildId();
    assert.equal(a, computeBuildId());
    assert.match(a, /^\d+\.\d+\.\d+-[0-9a-f]{10}$/);
    const sw = renderServiceWorker("x\nconst CACHE_NAME = 'agyrc-dev';\ny", a);
    assert.ok(sw.includes(`const CACHE_NAME = 'agyrc-${a}';`));
  });
});

describe('comandos "/" del chat (CHAT_COMMANDS, skills, salida CLI)', async () => {
  const { CHAT_COMMANDS, parseSkillsOutput, formatCliOutput, listChatCommands, isCliCommand, runCliCommand, setSkillsCacheForTests } =
    await import('../server/agy.js');

  test('parseSkillsOutput: salida real de agy --print=/skills', () => {
    const out = parseSkillsOutput(
      'agy-customizations\tComprehensive guide and reference for the Antigravity Customization System.\n' +
        'generative_ui\tHow to render rich interactive HTML widgets inline in the chat.\n' +
        '\n' +
        'Fetching skills...\n' +
        'nombre con espacios\tno válido\n'
    );
    assert.deepEqual(out.map((s) => s.name), ['agy-customizations', 'generative_ui']);
    assert.match(out[1].desc, /^How to render/);
  });

  test('parseSkillsOutput recorta descripciones a 200 chars y vacío → []', () => {
    assert.deepEqual(parseSkillsOutput(''), []);
    const [s] = parseSkillsOutput(`x\t${'a'.repeat(500)}`);
    assert.equal(s.desc.length, 200);
  });

  test('formatCliOutput: TSV → " · ", sin \\r, recorte a 20 KB', () => {
    assert.equal(formatCliOutput('Gemini Models\tWeekly\t99%\r\nRemaining credits\t0\n'), 'Gemini Models · Weekly · 99%\nRemaining credits · 0');
    const big = formatCliOutput('x'.repeat(30 * 1024));
    assert.ok(big.length <= 20 * 1024 + 2);
    assert.ok(big.endsWith('…'));
  });

  test('listChatCommands: integrados + skills en caché como kind prompt/group skill', async () => {
    setSkillsCacheForTests([{ name: 'generative_ui', desc: 'widgets' }]);
    const all = await listChatCommands();
    assert.equal(all.length, CHAT_COMMANDS.length + 1);
    const skill = all.at(-1);
    assert.deepEqual(skill, { cmd: '/generative_ui', kind: 'prompt', desc: 'widgets', group: 'skill' });
    for (const c of CHAT_COMMANDS) {
      assert.match(c.cmd, /^\/[a-z-]+$/);
      assert.ok(c.kind === 'prompt' || c.kind === 'cli');
      assert.ok(c.desc.length > 5);
    }
  });

  test('isCliCommand / runCliCommand solo aceptan los kind cli y llaman a agy --print=/cmd', async () => {
    assert.equal(isCliCommand('/usage'), true);
    assert.equal(isCliCommand('/plan'), false);
    assert.equal(isCliCommand('/rm -rf'), false);
    await assert.rejects(runCliCommand('/plan', '/tmp'), /no permitido/);
    const calls = [];
    const execImpl = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { stdout: 'Remaining credits\t0\nUpgrade\thttps://x\n', stderr: '' };
    };
    const out = await runCliCommand('/credits', '/tmp', { execImpl });
    assert.deepEqual(calls[0].args, ['--print=/credits']);
    assert.equal(calls[0].opts.cwd, '/tmp');
    assert.equal(out, 'Remaining credits · 0\nUpgrade · https://x');
    const empty = await runCliCommand('/agents', '/tmp', { execImpl: async () => ({ stdout: '', stderr: '' }) });
    assert.equal(empty, '(sin salida)');
  });
});
