// public/js/ui/directory.js
// Helpers de rutas (relativas a projectsRoot) y el mini-formulario "Nueva carpeta"
// reutilizados por chat-topbar.js, drawer.js y new-chat.js.

let projectsRootPromise = null;

/**
 * Devuelve (y cachea) projectsRoot absoluto vía GET /api/config. Degradado a '' si el
 * endpoint falla: los llamantes deben tratar '' como "desconocido" y mostrar rutas tal cual.
 * @param {typeof import('../api.js').api} api
 * @returns {Promise<string>}
 */
export function getProjectsRoot(api) {
  if (!projectsRootPromise) {
    projectsRootPromise = api('/config')
      .then((cfg) => (cfg && cfg.projectsRoot) || '')
      .catch(() => '');
  }
  return projectsRootPromise;
}

function stripTrailingSlash(p) {
  return String(p || '').replace(/\/+$/, '');
}

/**
 * @param {string} absPath ruta absoluta (p.ej. chat.cwd)
 * @param {string} projectsRoot absoluto, de getProjectsRoot()
 * @returns {boolean}
 */
export function isWithinRoot(absPath, projectsRoot) {
  if (!absPath || !projectsRoot) return false;
  const root = stripTrailingSlash(projectsRoot);
  const cur = stripTrailingSlash(absPath);
  return cur === root || cur.startsWith(`${root}/`);
}

/**
 * Ruta relativa a projectsRoot (sin '/' inicial), o '' si absPath es la propia raíz.
 * Devuelve null si absPath cae fuera de projectsRoot.
 * @param {string} absPath
 * @param {string} projectsRoot
 * @returns {string|null}
 */
export function toRelative(absPath, projectsRoot) {
  if (!isWithinRoot(absPath, projectsRoot)) return null;
  const root = stripTrailingSlash(projectsRoot);
  const cur = stripTrailingSlash(absPath);
  if (cur === root) return '';
  return cur.slice(root.length + 1);
}

/**
 * Formatea una ruta absoluta para mostrar: relativa a projectsRoot (p.ej. "agy-rc/public"),
 * "~/projects" si es la raíz, o la absoluta tal cual si cae fuera de projectsRoot o si
 * projectsRoot no se pudo determinar.
 * @param {string} absPath
 * @param {string} projectsRoot
 * @returns {string}
 */
export function relativeToRoot(absPath, projectsRoot) {
  if (!absPath) return '';
  if (!projectsRoot) return absPath;
  const rel = toRelative(absPath, projectsRoot);
  if (rel === null) return absPath;
  return rel === '' ? '~/projects' : rel;
}

/**
 * Mini-formulario inline reutilizable "Nueva carpeta": input de nombre + checkbox
 * "Inicializar repositorio git" + botones Crear/Cancelar. Lo usa el sheet "Nuevo chat"
 * (new-chat.js).
 * @param {{api: typeof import('../api.js').api,
 *          toast: typeof import('../ui/toast.js').toast,
 *          parent: string,
 *          onCreated: (relPath: string) => void,
 *          onCancel: () => void}} opts
 * @returns {HTMLElement & {focusInput: () => void}}
 */
export function buildNewFolderForm(opts) {
  const { api, toast, parent, onCreated, onCancel } = opts;

  const wrap = document.createElement('div');
  wrap.className = 'new-folder-form';
  wrap.innerHTML = `
    <input type="text" class="new-folder-form__input" placeholder="nombre-del-proyecto"
      autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="new-folder-form__git">
      <span>Inicializar repositorio git</span>
      <button type="button" class="toggle" data-on="true" role="switch" aria-checked="true">
        <span class="toggle__knob"></span>
      </button>
    </div>
    <div class="prompt-actions">
      <button type="button" class="btn" data-action="cancel">Cancelar</button>
      <button type="button" class="btn btn--primary" data-action="create">Crear</button>
    </div>
  `;

  const input = wrap.querySelector('.new-folder-form__input');
  const gitToggle = wrap.querySelector('.toggle');
  const cancelBtn = wrap.querySelector('[data-action="cancel"]');
  const createBtn = wrap.querySelector('[data-action="create"]');

  let gitOn = true;
  gitToggle.addEventListener('click', () => {
    gitOn = !gitOn;
    gitToggle.dataset.on = String(gitOn);
    gitToggle.setAttribute('aria-checked', String(gitOn));
  });

  async function submit() {
    const name = input.value.trim();
    if (!name) {
      toast('Ponle un nombre a la carpeta', { type: 'error' });
      return;
    }
    createBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const created = await api('/dirs', {
        method: 'POST',
        body: JSON.stringify({ parent: parent || '', name, git: gitOn }),
      });
      toast('Carpeta creada', { type: 'success' });
      onCreated(created.path);
    } catch (err) {
      toast(err.message || 'No se pudo crear la carpeta', { type: 'error' });
      createBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  }

  createBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => onCancel());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });

  wrap.focusInput = () => input.focus();
  return wrap;
}

function splitDisplayPath(display) {
  if (display === '~/projects') return { last: display, rest: '' };
  const norm = stripTrailingSlash(display);
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return { last: norm, rest: '' };
  return { last: norm.slice(idx + 1), rest: norm.slice(0, idx) };
}

export { splitDisplayPath };
