// public/js/chat/new-chat.js
// Sheet "Nuevo chat" (§2.4 CHAT.md): Proyecto (explorador + Nueva carpeta), Título opcional,
// Modelo, Esfuerzo, Modo (Normal · Plan · Aceptar ediciones), toggle Auto-aprobar (ON por
// defecto) y toggle Nuevo proyecto de Antigravity. Botón secundario "Reanudar conversación
// anterior…" crea el chat directamente con conversationId + cwd resuelto.

import { icon } from '../ui/icons.js';
import { buildNewFolderForm, getProjectsRoot, toRelative } from '../ui/directory.js';
import { t } from '../i18n.js';

const MODES = [
  { value: 'normal', label: t('Normal') },
  { value: 'plan', label: t('Plan') },
  { value: 'accept-edits', label: t('Aceptar ediciones') },
];

const DEFAULT_MODEL_ID = 'gemini-3.8-flash-high';

function basename(p) {
  if (!p) return '';
  const norm = String(p).replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t('hace un momento');
  if (mins < 60) return t('hace {n} min', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('hace {n} h', { n: hours });
  const days = Math.floor(hours / 24);
  return t('hace {n} d', { n: days });
}

/**
 * @param {HTMLElement} root #new-chat-sheet
 * @param {HTMLElement} backdrop #new-chat-backdrop
 * @param {{api: typeof import('../api.js').api, toast: typeof import('../ui/toast.js').toast,
 *          onCreated: (chat: object) => void}} deps
 */
export function mount(root, backdrop, deps) {
  const { api, toast, store, onCreated } = deps;

  let currentPath = '';
  let currentDisplay = '';
  let parentPath = null;
  let dirs = [];
  let models = null;
  let selectedModelId = '';
  let effort = 'medium';
  let mode = 'normal';
  let titleEdited = false;
  let projectsRoot = '';

  root.innerHTML = `
    <div class="sheet__handle"></div>
    <div class="sheet__header">
      <h2>${t('Nuevo chat')}</h2>
      <button type="button" class="sheet__close" aria-label="${t('Cerrar')}">${icon('close')}</button>
    </div>
    <div class="sheet__body">
      <div class="field">
        <label>${t('Carpeta de trabajo')}</label>
        <div class="dir-picker">
          <div class="dir-picker__current-card">
            <div class="dir-picker__current-icon">${icon('folder')}</div>
            <div class="dir-picker__current-info">
              <span class="dir-picker__current-label">${t('Carpeta seleccionada')}</span>
              <span class="dir-picker__current-name" id="nc-current-name">${t('~ (raíz)')}</span>
            </div>
            <button type="button" class="dir-picker__pin-btn" id="nc-pin-btn" title="${t('Fijar como carpeta por defecto')}">
              ${icon('star')}
              <span id="nc-pin-text">${t('Fijar')}</span>
            </button>
          </div>

          <div class="dir-picker__quick-chips" id="nc-quick-chips"></div>

          <div class="dir-picker__nav-bar">
            <button type="button" class="dir-picker__up-btn" id="nc-up-btn" title="${t('Subir un nivel')}" disabled>
              ${icon('arrowLeft')}
              <span>${t('Subir')}</span>
            </button>
            <div class="dir-picker__breadcrumb-scroll" id="nc-breadcrumb"></div>
          </div>

          <div class="dir-picker__list-wrap">
            <div class="dir-picker__list" id="nc-dirlist"></div>
          </div>

          <div class="dir-picker__bottom-bar">
            <button type="button" class="btn btn--subtle dir-picker__new-folder" id="nc-new-folder-btn">
              ${icon('folderPlus')}
              <span>${t('Nueva carpeta')}</span>
            </button>
            <button type="button" class="dir-picker__manual-toggle" id="nc-manual-toggle">
              <span>${t('Ruta manual')}</span>
              ${icon('pencil')}
            </button>
          </div>
          <div id="nc-new-folder-slot"></div>
          <div class="dir-picker__manual-row" id="nc-manual-row" hidden>
            <input type="text" id="nc-cwd" placeholder="${t('Ruta relativa a proyectos')}" autocomplete="off" autocapitalize="off" spellcheck="false">
          </div>
        </div>
      </div>
      <div class="field">
        <label for="nc-title">${t('Título (opcional)')}</label>
        <input type="text" id="nc-title" placeholder="${t('Se usa el primer mensaje si lo dejas vacío')}" autocomplete="off">
      </div>
      <div class="field">
        <label for="nc-model">${t('Modelo')}</label>
        <select id="nc-model"></select>
      </div>
      <div class="field">
        <label>${t('Esfuerzo')}</label>
        <div class="segmented" id="nc-effort"></div>
      </div>
      <div class="field">
        <label>${t('Modo')}</label>
        <div class="segmented" id="nc-mode"></div>
      </div>
      <div class="field toggle-row" id="nc-autoapprove-row">
        <div class="toggle-row__text">
          <span>${t('Auto-aprobar herramientas')}</span>
          <span class="toggle-row__desc">${t('Antigravity ejecuta comandos y edita archivos sin preguntar. Desactívalo para modo Plan o si quieres revisar.')}</span>
        </div>
        <button type="button" class="toggle" id="nc-autoapprove" role="switch" aria-checked="true"><span class="toggle__knob"></span></button>
      </div>
      <div class="field toggle-row" id="nc-new-project-row">
        <div class="toggle-row__text">
          <span>${t('Reindexar proyecto desde cero')}</span>
          <span class="toggle-row__desc">${t('Fuerza a Antigravity a analizar el código como si fuera nuevo, sin reutilizar el índice ni la memoria previa de esta carpeta.')}</span>
        </div>
        <button type="button" class="toggle" id="nc-new-project" role="switch" aria-checked="false"><span class="toggle__knob"></span></button>
      </div>
      <div class="prompt-actions">
        <button type="button" class="btn" data-action="cancel">${t('Cancelar')}</button>
        <button type="button" class="btn btn--primary" data-action="create">${t('Crear chat')}</button>
      </div>
      <button type="button" class="btn nc-resume-btn" id="nc-resume-btn">${t('Reanudar conversación anterior…')}</button>
      <div id="nc-resume-slot"></div>
    </div>
  `;

  const currentNameEl = root.querySelector('#nc-current-name');
  const pinBtn = root.querySelector('#nc-pin-btn');
  const pinText = root.querySelector('#nc-pin-text');
  const quickChipsEl = root.querySelector('#nc-quick-chips');
  const upBtn = root.querySelector('#nc-up-btn');
  const breadcrumbEl = root.querySelector('#nc-breadcrumb');
  const dirListEl = root.querySelector('#nc-dirlist');
  const manualToggle = root.querySelector('#nc-manual-toggle');
  const manualRow = root.querySelector('#nc-manual-row');
  const cwdInput = root.querySelector('#nc-cwd');
  const titleInput = root.querySelector('#nc-title');
  const modelSelect = root.querySelector('#nc-model');
  const effortSeg = root.querySelector('#nc-effort');
  const modeSeg = root.querySelector('#nc-mode');
  const autoApproveToggle = root.querySelector('#nc-autoapprove');
  const newProjectToggle = root.querySelector('#nc-new-project');
  const newFolderBtn = root.querySelector('#nc-new-folder-btn');
  const newFolderSlot = root.querySelector('#nc-new-folder-slot');
  const closeBtn = root.querySelector('.sheet__close');
  const cancelBtn = root.querySelector('[data-action="cancel"]');
  const createBtn = root.querySelector('[data-action="create"]');
  const resumeBtn = root.querySelector('#nc-resume-btn');
  const resumeSlot = root.querySelector('#nc-resume-slot');

  // ---------- toggles ----------

  function wireToggle(btn, initial) {
    let value = initial;
    btn.dataset.on = String(value);
    btn.setAttribute('aria-checked', String(value));
    btn.addEventListener('click', () => {
      value = !value;
      btn.dataset.on = String(value);
      btn.setAttribute('aria-checked', String(value));
    });
    return {
      get: () => value,
      set: (v) => {
        value = v;
        btn.dataset.on = String(value);
        btn.setAttribute('aria-checked', String(value));
      },
    };
  }

  const autoApproveState = wireToggle(autoApproveToggle, true);
  const newProjectState = wireToggle(newProjectToggle, false);

  // ---------- segmented: esfuerzo / modo ----------

  function renderSegmented(container, options, current, onSelect) {
    container.innerHTML = '';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'segmented__opt';
      btn.textContent = opt.label;
      if (opt.value === current) btn.dataset.active = 'true';
      btn.addEventListener('click', () => onSelect(opt.value));
      container.appendChild(btn);
    }
  }

  function renderEffort() {
    const current = models && models.find((m) => m.id === selectedModelId);
    const supportsEffort = !current || Boolean(current.effort);
    renderSegmented(
      effortSeg,
      [{ value: 'low', label: t('Bajo') }, { value: 'medium', label: t('Medio') }, { value: 'high', label: t('Alto') }],
      supportsEffort ? effort : null,
      (v) => {
        effort = v;
        setLastEffort(effort);
        renderEffort();
        if (models && current) {
          const variant = models.find((m) => m.family === current.family && m.effort === v);
          if (variant) {
            selectedModelId = variant.id;
            modelSelect.value = variant.id;
            setLastModel(selectedModelId);
          }
        }
      },
    );
    effortSeg.style.opacity = supportsEffort ? '1' : '0.4';
    effortSeg.style.pointerEvents = supportsEffort ? 'auto' : 'none';
  }

  function renderMode() {
    renderSegmented(modeSeg, MODES, mode, (v) => { mode = v; renderMode(); });
  }

  // ---------- modelo y esfuerzo preferidos ----------

  function getLastModel() {
    try {
      const saved = localStorage.getItem('agyrc.lastModel');
      if (saved) return saved;
    } catch {}
    if (store && store.state) {
      const active = store.getActiveChat ? store.getActiveChat() : null;
      if (active && active.model) return active.model;
      const chats = store.state.chats;
      if (Array.isArray(chats) && chats.length > 0) {
        const last = chats.find((c) => c && c.model);
        if (last && last.model) return last.model;
      }
    }
    return null;
  }

  function setLastModel(modelId) {
    try {
      if (modelId) localStorage.setItem('agyrc.lastModel', modelId);
    } catch {}
  }

  function getLastEffort() {
    try {
      const saved = localStorage.getItem('agyrc.lastEffort');
      if (saved) return saved;
    } catch {}
    if (store && store.state) {
      const active = store.getActiveChat ? store.getActiveChat() : null;
      if (active && active.effort) return active.effort;
      const chats = store.state.chats;
      if (Array.isArray(chats) && chats.length > 0) {
        const last = chats.find((c) => c && c.effort);
        if (last && last.effort) return last.effort;
      }
    }
    return null;
  }

  function setLastEffort(eff) {
    try {
      if (eff) localStorage.setItem('agyrc.lastEffort', eff);
    } catch {}
  }

  // ---------- directorios y preferencias de carpeta ----------

  function getDefaultFolder() {
    try {
      return localStorage.getItem('agyrc.defaultFolder');
    } catch {
      return null;
    }
  }

  function setDefaultFolder(path) {
    try {
      if (path === null) localStorage.removeItem('agyrc.defaultFolder');
      else localStorage.setItem('agyrc.defaultFolder', path);
    } catch {
      // ignore
    }
  }

  function getLastCwd() {
    try {
      return localStorage.getItem('agyrc.lastCwd');
    } catch {
      return null;
    }
  }

  function setLastCwd(path) {
    try {
      if (typeof path === 'string') localStorage.setItem('agyrc.lastCwd', path);
    } catch {
      // ignore
    }
  }

  function updatePinButtonUI() {
    const def = getDefaultFolder();
    const isPinned = def !== null && (def === currentPath || def === currentDisplay);
    pinBtn.dataset.pinned = isPinned ? 'true' : 'false';
    pinText.textContent = isPinned ? t('Por defecto') : t('Fijar');
    pinBtn.title = isPinned
      ? t('Carpeta fijada por defecto (toca para desfijar)')
      : t('Fijar como carpeta por defecto para nuevos chats');
  }

  pinBtn.addEventListener('click', () => {
    const def = getDefaultFolder();
    const isPinned = def !== null && (def === currentPath || def === currentDisplay);
    if (isPinned) {
      setDefaultFolder(null);
      toast(t('Se quitó la carpeta por defecto'), { type: 'info' });
    } else {
      setDefaultFolder(currentPath);
      toast(t('Fijada "{folder}" como carpeta por defecto', { folder: currentDisplay || currentPath }), { type: 'success' });
    }
    updatePinButtonUI();
    renderQuickChips();
  });

  upBtn.addEventListener('click', () => {
    if (parentPath !== null) {
      navigateTo(parentPath);
    }
  });

  manualToggle.addEventListener('click', () => {
    manualRow.hidden = !manualRow.hidden;
    if (!manualRow.hidden) cwdInput.focus();
  });

  function renderQuickChips() {
    quickChipsEl.innerHTML = '';
    const def = getDefaultFolder();
    const last = getLastCwd();
    let count = 0;

    // Chip Por defecto
    if (def !== null) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dir-picker__chip dir-picker__chip--pinned';
      const label = def.includes('/') ? basename(def) : def;
      chip.innerHTML = `${icon('star')}<span></span>`;
      chip.querySelector('span').textContent = t('Por defecto: {label}', { label });
      chip.title = t('Ir a {path}', { path: def });
      chip.addEventListener('click', () => navigateTo(def));
      quickChipsEl.appendChild(chip);
      count++;
    }

    // Chip Última carpeta usada
    if (last !== null && last !== def) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dir-picker__chip dir-picker__chip--last';
      const label = last.includes('/') ? basename(last) : last;
      chip.innerHTML = `${icon('history')}<span></span>`;
      chip.querySelector('span').textContent = t('Última: {label}', { label });
      chip.title = t('Ir a {path}', { path: last });
      chip.addEventListener('click', () => navigateTo(last));
      quickChipsEl.appendChild(chip);
      count++;
    }

    // Chip Inicio ~
    if (currentDisplay !== '~') {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dir-picker__chip';
      chip.innerHTML = `${icon('home')}<span>${t('Inicio ~')}</span>`;
      chip.title = t('Ir a la carpeta personal ~');
      chip.addEventListener('click', () => navigateTo('~'));
      quickChipsEl.appendChild(chip);
      count++;
    }

    // Chip Raíz /
    if (currentPath !== '/' && currentDisplay !== '/') {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dir-picker__chip';
      chip.innerHTML = `<span>${t('/ (raíz)')}</span>`;
      chip.title = t('Ir a la raíz del sistema /');
      chip.addEventListener('click', () => navigateTo('/'));
      quickChipsEl.appendChild(chip);
      count++;
    }

    quickChipsEl.hidden = count === 0;
  }

  function renderBreadcrumb() {
    breadcrumbEl.innerHTML = '';
    upBtn.disabled = parentPath === null;

    const isHomeRel = currentDisplay.startsWith('~');
    const segs = (isHomeRel ? currentDisplay.slice(1) : currentDisplay)
      .split('/')
      .filter(Boolean);

    const rootBtn = document.createElement('button');
    rootBtn.type = 'button';
    rootBtn.className = 'dir-picker__crumb-btn';
    rootBtn.textContent = isHomeRel ? '~' : '/';
    rootBtn.title = isHomeRel ? t('Ir a la carpeta personal ~') : t('Ir a la raíz del sistema /');
    rootBtn.addEventListener('click', () => navigateTo(isHomeRel ? '~' : '/'));
    breadcrumbEl.appendChild(rootBtn);

    let acc = isHomeRel ? '~' : '';
    for (const seg of segs) {
      const sep = document.createElement('span');
      sep.className = 'dir-picker__crumb-sep';
      sep.textContent = ' › ';
      breadcrumbEl.appendChild(sep);

      acc = `${acc}/${seg}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dir-picker__crumb-btn';
      btn.textContent = seg;
      const target = acc;
      btn.addEventListener('click', () => navigateTo(target));
      breadcrumbEl.appendChild(btn);
    }

    setTimeout(() => {
      breadcrumbEl.scrollLeft = breadcrumbEl.scrollWidth;
    }, 10);
  }

  function renderDirList() {
    dirListEl.innerHTML = '';
    if (dirs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dir-picker__empty';
      empty.innerHTML = `
        <span style="color:#a78bfa">${icon('folder')}</span>
        <span>${t('Sin subcarpetas en este nivel')}</span>
        <span style="font-size:11px;color:var(--text-faint)">${t('Antigravity trabajará en esta carpeta')}</span>
      `;
      dirListEl.appendChild(empty);
      return;
    }

    for (const name of dirs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dir-picker__item';

      const left = document.createElement('div');
      left.className = 'dir-picker__item-left';

      const iconSpan = document.createElement('span');
      iconSpan.className = 'dir-picker__item-icon';
      iconSpan.innerHTML = icon('folder');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'dir-picker__item-name';
      nameSpan.textContent = name;

      left.appendChild(iconSpan);
      left.appendChild(nameSpan);

      const arrowSpan = document.createElement('span');
      arrowSpan.className = 'dir-picker__item-arrow';
      arrowSpan.innerHTML = icon('chevronRight');

      btn.appendChild(left);
      btn.appendChild(arrowSpan);

      btn.addEventListener('click', () => {
        const next = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
        navigateTo(next);
      });
      dirListEl.appendChild(btn);
    }
  }

  async function loadDirs(path) {
    try {
      const res = await api(`/dirs?path=${encodeURIComponent(path || '')}`);
      currentPath = res.path || path || '';
      currentDisplay = res.display || currentPath;
      parentPath = res.parent !== undefined ? res.parent : null;
      dirs = res.dirs || [];
    } catch (err) {
      dirs = [];
      toast(t('No se pudo listar el directorio: {message}', { message: err.message }), { type: 'error' });
    }
    currentNameEl.textContent = currentDisplay || '~';
    cwdInput.value = currentPath;
    updatePinButtonUI();
    renderQuickChips();
    renderBreadcrumb();
    renderDirList();
  }

  function navigateTo(path) {
    loadDirs(path);
  }

  // ---------- nueva carpeta ----------

  function closeNewFolderForm() {
    newFolderSlot.innerHTML = '';
    newFolderBtn.hidden = false;
  }

  function openNewFolderForm() {
    newFolderBtn.hidden = true;
    const form = buildNewFolderForm({
      api,
      toast,
      parent: currentPath,
      onCreated: (newRel) => {
        closeNewFolderForm();
        loadDirs(newRel);
      },
      onCancel: () => closeNewFolderForm(),
    });
    newFolderSlot.innerHTML = '';
    newFolderSlot.appendChild(form);
    form.focusInput();
  }

  newFolderBtn.addEventListener('click', openNewFolderForm);

  // ---------- modelos ----------

  async function loadModels() {
    modelSelect.innerHTML = `<option>${t('Cargando…')}</option>`;
    modelSelect.disabled = true;
    try {
      const res = await api('/agy/models');
      models = Array.isArray(res.models) ? res.models : [];
    } catch {
      models = null;
    }

    modelSelect.innerHTML = '';
    modelSelect.disabled = false;

    if (!models || models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = models === null ? t('No disponible (se usará el modelo por defecto)') : t('Sin modelos');
      modelSelect.appendChild(opt);
      modelSelect.disabled = true;
      selectedModelId = '';
      return;
    }

    const families = new Map();
    for (const m of models) {
      if (!families.has(m.family)) families.set(m.family, []);
      families.get(m.family).push(m);
    }
    for (const [family, variants] of families) {
      const group = document.createElement('optgroup');
      group.label = family;
      for (const m of variants) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.effort ? `${family} (${m.effort})` : family;
        group.appendChild(opt);
      }
      modelSelect.appendChild(group);
    }

    let lastModel = getLastModel();
    let lastEffort = getLastEffort();

    if (!lastModel) {
      try {
        const recentChats = await api('/chats');
        if (Array.isArray(recentChats) && recentChats.length > 0) {
          const found = recentChats.find((c) => c && c.model);
          if (found && found.model) {
            lastModel = found.model;
            if (!lastEffort && found.effort) lastEffort = found.effort;
            setLastModel(lastModel);
            if (lastEffort) setLastEffort(lastEffort);
          }
        }
      } catch {}
    }

    let matched = null;
    if (lastModel) {
      matched = models.find((m) => m.id === lastModel || m.family === lastModel);
      if (!matched) {
        const norm = lastModel.toLowerCase();
        matched = models.find((m) => m.id.toLowerCase().includes(norm) || m.family.toLowerCase().includes(norm));
      }
    }

    if (!matched) {
      const hasDefault = models.some((m) => m.id === DEFAULT_MODEL_ID);
      selectedModelId = hasDefault ? DEFAULT_MODEL_ID : models[0].id;
    } else {
      selectedModelId = matched.id;
    }

    modelSelect.value = selectedModelId;
    const initial = models.find((m) => m.id === selectedModelId);
    if (lastEffort && (!initial || initial.effort)) {
      effort = lastEffort;
      if (initial && initial.effort !== lastEffort) {
        const variant = models.find((m) => m.family === initial.family && m.effort === lastEffort);
        if (variant) {
          selectedModelId = variant.id;
          modelSelect.value = variant.id;
        }
      }
    } else if (initial && initial.effort) {
      effort = initial.effort;
    }
    renderEffort();
  }

  modelSelect.addEventListener('change', () => {
    selectedModelId = modelSelect.value;
    setLastModel(selectedModelId);
    if (models) {
      const current = models.find((m) => m.id === selectedModelId);
      if (current && current.effort) {
        effort = current.effort;
        setLastEffort(effort);
      }
      renderEffort();
    }
  });

  // ---------- reanudar conversación anterior ----------

  function closeResumeList() {
    resumeSlot.innerHTML = '';
    resumeBtn.hidden = false;
  }

  async function openResumeList() {
    resumeBtn.hidden = true;
    resumeSlot.innerHTML = `<div class="sheet__loading">${t('Cargando conversaciones…')}</div>`;
    let items = [];
    try {
      const res = await api('/agy/conversations?limit=50');
      items = Array.isArray(res) ? res : [];
    } catch (err) {
      resumeSlot.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'sheet__hint';
      p.textContent = t('No se pudieron cargar las conversaciones: {message}', { message: err.message });
      resumeSlot.appendChild(p);
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn';
      back.textContent = t('Volver');
      back.addEventListener('click', closeResumeList);
      resumeSlot.appendChild(back);
      return;
    }

    resumeSlot.innerHTML = '';
    if (items.length === 0) {
      const p = document.createElement('p');
      p.className = 'sheet__hint';
      p.textContent = t('No hay conversaciones anteriores.');
      resumeSlot.appendChild(p);
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn';
      back.textContent = t('Volver');
      back.addEventListener('click', closeResumeList);
      resumeSlot.appendChild(back);
      return;
    }

    const list = document.createElement('div');
    list.className = 'option-list';
    for (const conv of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'option-row option-row--stacked';

      const top = document.createElement('div');
      top.className = 'option-row__top';
      const label = document.createElement('span');
      label.className = 'option-row__label';
      label.textContent = conv.title || t('(sin título)');
      top.appendChild(label);
      row.appendChild(top);

      const desc = document.createElement('div');
      desc.className = 'option-row__desc';
      const folder = basename(conv.workspace || '');
      desc.textContent = [folder, timeAgo(conv.lastAt)].filter(Boolean).join(' · ');
      row.appendChild(desc);

      row.addEventListener('click', () => resumeConversation(conv));
      list.appendChild(row);
    }
    resumeSlot.appendChild(list);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn';
    back.style.marginTop = '10px';
    back.textContent = t('Volver');
    back.addEventListener('click', closeResumeList);
    resumeSlot.appendChild(back);
  }

  resumeBtn.addEventListener('click', openResumeList);

  async function resumeConversation(conv) {
    createBtn.disabled = true;
    try {
      let cwd = currentPath;
      if (conv.workspace) {
        const rel = toRelative(conv.workspace, projectsRoot);
        if (rel !== null) cwd = rel;
      }
      const chat = await api('/chats', {
        method: 'POST',
        body: JSON.stringify({
          title: conv.title || undefined,
          cwd,
          model: selectedModelId || undefined,
          effort,
          mode,
          autoApprove: autoApproveState.get(),
          newProject: false,
          conversationId: conv.conversationId,
        }),
      });
      setLastCwd(cwd);
      close();
      onCreated(chat);
    } catch (err) {
      toast(err.message || t('No se pudo reanudar la conversación'), { type: 'error' });
    } finally {
      createBtn.disabled = false;
    }
  }

  // ---------- ciclo de vida ----------

  function reset(initialCwd) {
    titleEdited = false;
    titleInput.value = '';
    effort = 'medium';
    mode = 'normal';
    autoApproveState.set(true);
    newProjectState.set(false);
    closeNewFolderForm();
    closeResumeList();
    renderEffort();
    renderMode();

    let targetCwd = initialCwd;
    if (targetCwd === undefined) {
      const def = getDefaultFolder();
      const last = getLastCwd();
      targetCwd = def !== null ? def : (last !== null ? last : '');
    }

    manualRow.hidden = true;
    loadDirs(targetCwd || '');
    loadModels();
  }

  /**
   * @param {{cwd?: string}} [opts]
   */
  function open(opts = {}) {
    root.dataset.open = 'true';
    backdrop.dataset.open = 'true';
    root.setAttribute('aria-hidden', 'false');
    getProjectsRoot(api).then((r) => { projectsRoot = r; });
    reset(opts.cwd);
  }

  function close() {
    root.dataset.open = 'false';
    backdrop.dataset.open = 'false';
    root.setAttribute('aria-hidden', 'true');
  }

  titleInput.addEventListener('input', () => {
    titleEdited = true;
  });

  cwdInput.addEventListener('change', () => {
    navigateTo(cwdInput.value.trim());
  });

  async function create() {
    createBtn.disabled = true;
    try {
      const finalCwd = cwdInput.value.trim();
      const chat = await api('/chats', {
        method: 'POST',
        body: JSON.stringify({
          title: titleInput.value.trim() || undefined,
          cwd: finalCwd,
          model: selectedModelId || undefined,
          effort,
          mode,
          autoApprove: autoApproveState.get(),
          newProject: newProjectState.get(),
        }),
      });
      setLastCwd(finalCwd);
      if (selectedModelId) setLastModel(selectedModelId);
      if (effort) setLastEffort(effort);
      close();
      onCreated(chat);
    } catch (err) {
      toast(err.message || t('No se pudo crear el chat'), { type: 'error' });
    } finally {
      createBtn.disabled = false;
    }
  }

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  createBtn.addEventListener('click', create);

  void titleEdited; // reservado: título por defecto lo calcula el backend a partir del primer mensaje

  return { open, close };
}
