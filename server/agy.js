// server/agy.js
// Conocimiento específico de la CLI Antigravity (agy): catálogo de modelos y
// lectura de su línea de estado ("[modo · ]Modelo · esfuerzo") desde la pantalla tmux.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

const MODELS_TTL_MS = 10 * 60 * 1000;
let modelsCache = { at: 0, models: null };

/**
 * Parsea la salida de `agy models` (líneas `id<TAB>label`; ignora "Fetching…").
 * Pura, para poder testear.
 * @param {string} stdout
 * @returns {Array<{id:string,label:string,family:string,effort:string|null}>}
 */
export function parseModelsOutput(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('\t')) continue;
    const [id, ...rest] = line.split('\t');
    const label = rest.join(' ').trim();
    if (!/^[\w.-]+$/.test(id)) continue;
    // "Gemini 3.7 Flash (High)" → family "Gemini 3.7 Flash", effort "high";
    // "Claude Sonnet 4.6 (Thinking)" → family completa, effort null.
    const m = label.match(/^(.*?)\s*\((Low|Medium|High)\)\s*$/i);
    out.push({
      id,
      label,
      family: m ? m[1].trim() : label,
      effort: m ? m[2].toLowerCase() : null,
    });
  }
  return out;
}

/**
 * Lista los modelos disponibles ejecutando `agy models` (cache 10 min).
 * @returns {Promise<Array<{id:string,label:string,family:string,effort:string|null}>>}
 */
export async function listModels() {
  const now = Date.now();
  if (modelsCache.models && now - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
  const { stdout } = await execFileAsync(config.AGY_CMD, ['models'], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const models = parseModelsOutput(stdout);
  if (models.length > 0) modelsCache = { at: now, models };
  return models;
}

/**
 * Resuelve el id de modelo a pasar en `--model` para un esfuerzo dado. En agy el esfuerzo va
 * codificado en el id (`gemini-3.7-flash-medium`) y combinar `--model <id>` con `--effort` distinto
 * es un error ("invalid model selection"), así que se elige la variante de la misma familia con
 * ese esfuerzo. Ids desconocidos (o familias sin variantes, p.ej. Claude) se devuelven tal cual.
 * @param {string|null|undefined} modelId
 * @param {string|null|undefined} effort
 * @returns {Promise<string|null>}
 */
export async function resolveModelId(modelId, effort) {
  if (!modelId) return null;
  let models;
  try {
    models = await listModels();
  } catch {
    return modelId;
  }
  const current = models.find((m) => m.id === modelId);
  if (!current || !effort || !current.effort || current.effort === effort) return modelId;
  const variant = models.find((m) => m.family === current.family && m.effort === effort);
  return variant ? variant.id : modelId;
}

/** Fija el catálogo en caché sin ejecutar agy (tests). */
export function setModelsCacheForTests(models) {
  modelsCache = { at: Date.now(), models };
}

/** Invalida la caché (tests). */
export function resetModelsCache() {
  modelsCache = { at: 0, models: null };
}

const STATUS_RE = /(?:\b(accept-edits|plan)\s*·\s*)?([^·]+?)\s*·\s*(low|medium|high)\s*$/;

/**
 * Extrae `{mode, model, effort}` de la última fila no vacía de la pantalla de agy.
 * Formato observado (agy 1.1.23): `? for shortcuts        [plan · ]Gemini 3.1 Pro · high`
 * o, con un menú abierto, `esc to cancel                 Gemini 3.7 Flash · medium`.
 * Pura, para poder testear.
 * @param {string} screen texto de capture-pane (pantalla visible)
 * @returns {{mode:'normal'|'accept-edits'|'plan', model:string, effort:'low'|'medium'|'high'}|null}
 */
export function parseAgyStatus(screen) {
  const lines = String(screen || '').split('\n');
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      last = lines[i];
      break;
    }
  }
  if (!last) return null;
  const m = last.match(STATUS_RE);
  if (!m) return null;
  // El nombre del modelo es lo que hay tras el último bloque de ≥2 espacios (la parte izquierda
  // de la fila lleva "? for shortcuts" / "esc to cancel").
  const modelRaw = m[2].split(/\s{2,}|\t/).pop().trim();
  if (!modelRaw) return null;
  return { mode: m[1] || 'normal', model: modelRaw, effort: m[3] };
}

// ---------------------------------------------------------------------------
// Comandos "/" de agy utilizables desde el modo chat (stream-json). Verificado con agy 1.1.24:
//  - kind 'prompt': agy los expande dentro del turno (van tal cual en el texto del mensaje).
//  - kind 'cli': "answered by the CLI itself" → no funcionan por stdin en stream-json, pero sí como
//    invocación propia `agy --print=/cmd`; su salida se muestra en el chat como mensaje de sistema.
//  `desc` es el texto en español y `descEn` en inglés (la PWA elige según su idioma).
//  Los demás (/context, /diff, /rewind, /resume, /fork, /clear, /btw, /codesearch, /config…) abren
//  paneles del TUI y agy los rechaza en modo print, así que no se ofrecen.

export const CHAT_COMMANDS = [
  { cmd: '/plan', kind: 'prompt', desc: 'Planifica con cuidado antes de ejecutar la tarea', descEn: 'Plan carefully before executing the task' },
  { cmd: '/goal', kind: 'prompt', desc: 'Sigue trabajando hasta terminar por completo el objetivo', descEn: 'Keep working until the goal is fully complete' },
  { cmd: '/grill-me', kind: 'prompt', desc: 'Te entrevista para alinear el plan antes de empezar', descEn: 'Interviews you to align the plan before starting' },
  { cmd: '/browser', kind: 'prompt', desc: 'Agente de navegador para tareas web', descEn: 'Browser agent for web tasks' },
  { cmd: '/boost', kind: 'prompt', desc: 'Orquestador multiagente Boost para tareas complejas', descEn: 'Boost multi-agent orchestrator for complex tasks' },
  { cmd: '/teamwork-preview', kind: 'prompt', desc: 'Equipo de agentes autónomos para proyectos grandes', descEn: 'Team of autonomous agents for large projects' },
  { cmd: '/learn', kind: 'prompt', desc: 'Reflexiona sobre aciertos/correcciones y propone skills o reglas', descEn: 'Reflects on successes/corrections and proposes skills or rules' },
  { cmd: '/schedule', kind: 'prompt', desc: 'Ejecuta una instrucción con temporizador o de forma recurrente', descEn: 'Runs an instruction on a timer or on a schedule' },
  { cmd: '/usage', kind: 'cli', desc: 'Cuota restante de los modelos (5 h y semanal)', descEn: 'Remaining model quota (5 h and weekly)' },
  { cmd: '/credits', kind: 'cli', desc: 'Créditos G1 restantes', descEn: 'Remaining G1 credits' },
  { cmd: '/skills', kind: 'cli', desc: 'Lista las skills disponibles', descEn: 'Lists the available skills' },
  { cmd: '/agents', kind: 'cli', desc: 'Lista los agentes personalizados', descEn: 'Lists the custom agents' },
  { cmd: '/changelog', kind: 'cli', desc: 'Novedades de la versión de agy', descEn: 'What\'s new in this agy version' },
];

const CLI_COMMAND_SET = new Set(CHAT_COMMANDS.filter((c) => c.kind === 'cli').map((c) => c.cmd));
const SKILLS_TTL_MS = 10 * 60 * 1000;
const CLI_OUTPUT_MAX = 20 * 1024;
let skillsCache = { at: 0, skills: null };

/**
 * Parsea `agy --print=/skills` (líneas `nombre<TAB>descripción`; ignora líneas sin tab). Pura.
 * @param {string} stdout
 * @returns {Array<{name:string, desc:string}>}
 */
export function parseSkillsOutput(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const tab = raw.indexOf('\t');
    if (tab <= 0) continue;
    const name = raw.slice(0, tab).trim();
    if (!/^[\w.-]+$/.test(name)) continue;
    out.push({ name, desc: raw.slice(tab + 1).trim().slice(0, 200) });
  }
  return out;
}

/** Skills instaladas (cada una se invoca como `/nombre …` en el prompt). Cache 10 min. */
export async function listSkills() {
  const now = Date.now();
  if (skillsCache.skills && now - skillsCache.at < SKILLS_TTL_MS) return skillsCache.skills;
  const { stdout } = await execFileAsync(config.AGY_CMD, ['--print=/skills'], {
    cwd: config.AGY_PROJECTS_ROOT,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const skills = parseSkillsOutput(stdout);
  skillsCache = { at: now, skills };
  return skills;
}

/**
 * Catálogo completo para el menú "/" del chat: comandos integrados + skills (kind 'prompt',
 * group 'skill'). Si `agy --print=/skills` falla, devuelve solo los integrados.
 * @returns {Promise<Array<{cmd:string, kind:'prompt'|'cli', desc:string, group?:string}>>}
 */
export async function listChatCommands() {
  let skills = [];
  try {
    skills = await listSkills();
  } catch {
    skills = [];
  }
  return [
    ...CHAT_COMMANDS,
    ...skills.map((s) => ({ cmd: `/${s.name}`, kind: 'prompt', desc: s.desc, group: 'skill' })),
  ];
}

export function isCliCommand(cmd) {
  return CLI_COMMAND_SET.has(cmd);
}

/**
 * Salida de un comando 'cli' formateada para el chat: TSV → columnas separadas por " · ",
 * recortada a 20 KB.
 * @param {string} stdout
 */
export function formatCliOutput(stdout) {
  const text = String(stdout || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\t+/g, ' · ').trimEnd())
    .join('\n')
    .trim();
  return text.length > CLI_OUTPUT_MAX ? `${text.slice(0, CLI_OUTPUT_MAX)}\n…` : text;
}

/**
 * Ejecuta un comando 'cli' (`agy --print=/usage`) en `cwd` y devuelve su salida formateada.
 * @param {string} cmd uno de los kind 'cli' de CHAT_COMMANDS (si no, HttpError 400 del llamante)
 * @param {string} cwd
 * @param {{execImpl?: typeof execFileAsync}} [opts]
 */
export async function runCliCommand(cmd, cwd, { execImpl = execFileAsync } = {}) {
  if (!isCliCommand(cmd)) throw new Error(`comando no permitido: ${cmd}`);
  const { stdout, stderr } = await execImpl(config.AGY_CMD, [`--print=${cmd}`], {
    cwd,
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const out = formatCliOutput(stdout);
  return out || formatCliOutput(stderr) || '(sin salida)';
}

/** Fija la caché de skills sin ejecutar agy (tests). */
export function setSkillsCacheForTests(skills) {
  skillsCache = { at: Date.now(), skills };
}
