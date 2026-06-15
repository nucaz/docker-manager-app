// app.js — Renderer process: lógica de la UI
'use strict';

const api = window.dockerAPI;

// ═══════════════════════════════════════════════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════════════════════════════════════════════
const state = {
  containers:     [],
  images:         [],
  volumes:        [],
  stats:          {},
  projects:       [],
  selectedProject:'all',
  activeTab:      'containers',
  logsStreamId:   null,
  followLogs:     false,
  packStreamId:   null,
  deployStreamId: null,
  scpStreamId:    null,
  cloudStreamId:  null,
  selectedCloud:  null,
  cloudImages:        [],       // queue: [{repo, tag, size, destTag}]
  cloudProjFilter:    'all',    // current project chip selected
  cloudRegistryCreds: null,     // {registry, username, password} tras login exitoso
  ctxContainer:       null,     // container under right-click
  settings: {
    autoRefresh: true,
    refreshInterval: 15,
  },
};

let refreshTimer = null;
const wslLogBuffer = [];   // persistent WSL command log (survives tab switches)
let currentLogSource = 'docker'; // 'docker' | 'wsl'

// ═══════════════════════════════════════════════════════════════════════════════
// INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════════════════════════
async function init() {
  try { loadSettings(); } catch(e) { console.warn('loadSettings error:', e); }
  try { setupStreamListeners(); } catch(e) { console.warn('setupStreamListeners error:', e); }
  try { setupContextMenu(); } catch(e) { console.warn('setupContextMenu error:', e); }
  // Chequeo automático de dependencias y seguridad al inicio (no bloqueante)
  setTimeout(runStartupSecurityCheck, 4000);

  // F5 → refresh
  document.addEventListener('keydown', e => {
    if (e.key === 'F5') refreshAll();
  });

  // Cerrar menú contextual al hacer click en otro lugar
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });

  // Guard: if api is not available (preload failed), show error immediately
  if (!api || typeof api.test !== 'function') {
    const badge = document.getElementById('docker-version-badge');
    if (badge) { badge.textContent = 'Error: preload no disponible'; badge.className = 'badge-docker badge-error'; }
    showDockerOfflineState('Error interno: el bridge de seguridad no se inicializó correctamente. Reinicia la aplicación.');
    return;
  }

  await checkDockerConnection();
}

async function checkDockerConnection() {
  const badge = $id('docker-version-badge');
  badge.textContent = 'Docker — verificando…';

  // Clear the loading spinners immediately so they don't persist on error
  const grid = $id('container-grid');
  if (grid && grid.querySelector('.loading-row')) {
    grid.innerHTML = '<div style="padding:20px;color:var(--text-3);font-size:13px">Conectando con Docker…</div>';
  }

  const res = await api.test().catch(e => ({ ok: false, error: e.message }));

  if (res.ok) {
    badge.textContent = `Docker ${res.version}`;
    badge.className   = 'badge-docker';
    await refreshAll();
    startAutoRefresh();
  } else {
    badge.textContent = '❌ Docker no conectado';
    badge.className   = 'badge-docker badge-error';
    showDockerOfflineState(res.error);
  }
}

function showDockerOfflineState(errorMsg) {
  const clean = (errorMsg || '')
    .replace(/Command failed.*?:\s*/i, '')
    .slice(0, 200);

  // Actualizar stats
  ['s-running','s-stopped','s-images','s-volumes','s-diskused'].forEach(id => {
    const el = $id(id); if (el) el.textContent = '—';
  });

  // Mostrar en el grid de contenedores
  const grid = $id('container-grid');
  if (grid) grid.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🚫</div>
      <p style="color:var(--red);font-size:15px;font-weight:600">Docker no está disponible</p>
      <p style="font-size:12px;color:var(--text-2);max-width:420px;text-align:center;line-height:1.6;margin-top:6px">
        ${escHtml(clean || 'Asegúrate de que Docker Desktop esté corriendo antes de abrir esta herramienta.')}
      </p>
      <div style="margin-top:20px;display:flex;gap:10px">
        <button class="btn blue" onclick="checkDockerConnection()">↻ Reintentar</button>
        <button class="btn" onclick="showTab('settings')">⚙️ Configuración</button>
      </div>
      <p style="font-size:11px;color:var(--text-3);margin-top:16px">
        💡 Si Docker Desktop está abierto, espera a que termine de iniciar y reintenta.
      </p>
    </div>`;
}

async function refreshAll() {
  await Promise.all([
    refreshContainerData(),
    refreshImages(),
    refreshVolumes(),
    refreshSystemInfo(),
  ]);
  refreshStats(); // async, no await — llega cuando puede
}

async function refreshContainerData() {
  const [cRes, pRes] = await Promise.all([
    api.getContainers(),
    api.getProjects(),
  ]);

  if (cRes.ok) state.containers = cRes.data || [];
  if (pRes.ok) state.projects   = pRes.data || [];

  renderContainers();
  renderProjectFilter();
  updateBadges();
  populateLogSelect();
}

async function refreshImages() {
  const res = await api.getImages();
  if (res.ok) state.images = res.data || [];
  renderImages();
  $id('badge-images').textContent = state.images.length;
  $id('s-images').textContent = state.images.length;
  // Keep cloud dropdown in sync if panel is already open
  if (state.selectedCloud) populateCloudImageDropdown();
}

async function refreshVolumes() {
  const res = await api.getVolumes();
  if (res.ok) state.volumes = res.data || [];
  renderVolumes();
  $id('badge-volumes').textContent = state.volumes.length;
  $id('s-volumes').textContent = state.volumes.length;
}

async function refreshStats() {
  const res = await api.getStats();
  if (!res.ok) return;

  state.stats = {};
  (res.data || []).forEach(s => {
    state.stats[s.ID || s.Container] = s;
  });

  // Actualizar sólo las barras en las cards ya pintadas
  renderContainerStats();
}

async function refreshSystemInfo() {
  const [infoRes, dfRes] = await Promise.all([
    api.getInfo(),
    api.getSystemDf(),
  ]);

  // Docker version badge
  if (infoRes.ok && infoRes.data?.Client?.Version) {
    const v = infoRes.data.Client.Version;
    const badge = $id('docker-version-badge');
    badge.textContent = `Docker ${v}`;
    badge.className = 'badge-docker';
  }

  // Disk usage
  if (dfRes.ok && dfRes.data.length) {
    const types = {};
    dfRes.data.forEach(d => { types[d.Type] = d; });
    const imgs  = types['Images']    || types['images']    || {};
    const vols  = types['Local Volumes'] || types['local volumes'] || {};
    const conts = types['Containers'] || types['containers'] || {};
    const total = sumBytes([imgs.Size, vols.Size, conts.Size]);
    $id('s-diskused').textContent = total || '—';
  }

  // Footer
  $id('sidebar-footer').innerHTML =
    `<span style="color:var(--text-3)">Docker ${infoRes.ok && infoRes.data?.Client?.Version ? infoRes.data.Client.Version : '—'}</span><br>
     ${state.containers.length} contenedores`;
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (!state.settings.autoRefresh) return;
  const ms = (state.settings.refreshInterval || 15) * 1000;
  refreshTimer = setInterval(() => refreshAll(), ms);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER — CONTENEDORES
// ═══════════════════════════════════════════════════════════════════════════════
function renderContainers() {
  const grid    = $id('container-grid');
  const search  = ($id('search-containers').value || '').toLowerCase();
  const filter  = $id('filter-state').value;
  const project = state.selectedProject;

  let list = state.containers;

  if (project !== 'all')
    list = list.filter(c => c.composeProject === project);

  if (filter !== 'all')
    list = list.filter(c => (c.State || '').toLowerCase() === filter);

  if (search)
    list = list.filter(c =>
      (c.Names || '').toLowerCase().includes(search) ||
      (c.Image  || '').toLowerCase().includes(search));

  // Counts: mostrar totales globales, pero badge del sidebar = filtrado
  const totalRunning = state.containers.filter(c => c.State === 'running').length;
  const totalStopped = state.containers.filter(c => c.State === 'exited').length;
  const filtRunning  = list.filter(c => c.State === 'running').length;
  const filtStopped  = list.filter(c => c.State === 'exited').length;

  const isFiltered = state.selectedProject !== 'all';
  $id('container-count').textContent = isFiltered
    ? `${list.length} de ${state.containers.length} (proyecto: ${state.selectedProject})`
    : `${list.length} total`;

  $id('badge-running').textContent = isFiltered ? filtRunning : totalRunning;
  $id('s-running').textContent     = isFiltered ? filtRunning : totalRunning;
  $id('s-stopped').textContent     = isFiltered ? filtStopped : totalStopped;

  if (!list.length) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🐳</div>
      <p>No hay contenedores que mostrar</p>
      <button class="btn blue" onclick="refreshContainerData()">↻ Actualizar</button>
    </div>`;
    return;
  }

  grid.innerHTML = list.map(c => containerCard(c)).join('');
  // Cargar IPs de contenedores en ejecución
  list.filter(c => (c.State || '').toLowerCase() === 'running').forEach(c => loadContainerIp(c.ID));
}

function containerCard(c) {
  const id    = c.ID || '';
  const name  = (c.Names || id).replace(/^\//, '');
  const state = (c.State || 'unknown').toLowerCase();
  const image = c.Image || '—';
  const ports = formatPorts(c.Ports || '');
  const age   = c.RunningFor || c.CreatedAt || '—';
  const size  = c.Size || '—';
  const proj  = c.composeProject || '';
  const svc   = c.composeService  || '';

  const stats      = state === 'running' ? findStats(id, name) : null;
  const cpuPct     = stats ? parseFloat(stats.CPUPerc)  || 0 : 0;
  const memUsage   = stats ? (stats.MemUsage || '—')         : '—';
  const memPct     = stats ? parseFloat(stats.MemPerc)  || 0 : 0;

  const stateClass = state === 'running' ? 'running' :
                     state === 'paused'  ? 'paused'  : 'exited';

  const stateLabel = state === 'running' ? 'Corriendo' :
                     state === 'exited'  ? 'Detenido'  :
                     state === 'paused'  ? 'Pausado'   : state;

  const canStart   = state !== 'running';
  const canStop    = state === 'running' || state === 'paused';
  const canRestart = state === 'running';

  return `
<div class="container-card ${stateClass}" id="card-${id}">
  <div class="card-row1">
    <div class="status-dot ${stateClass}"></div>
    <span class="container-name">${escHtml(name)}</span>
    <span class="container-status-text">${c.Status || stateLabel}</span>
    ${proj ? `<span class="project-badge">${escHtml(proj)}${svc ? ' · ' + escHtml(svc) : ''}</span>` : ''}
  </div>

  <div class="card-row2">
    <div class="card-meta">
      <span class="label">Imagen</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(image)}">${escHtml(image)}</span>
      ${ports ? `<span class="label" style="margin-top:5px">Puertos</span><span>${escHtml(ports)}${countMappedPorts(c.Ports) > 0 ? `<span class="port-count-badge">${countMappedPorts(c.Ports)}</span>` : ''}</span>` : ''}
      ${state === 'running' ? `<span class="label" style="margin-top:5px">IP</span><span id="ip-${id}" class="container-ip">…</span>` : ''}
      <span class="label" style="margin-top:5px">Creado</span>
      <span>${escHtml(age)}</span>
    </div>

    <div class="card-bars">
      <div class="bar-row">
        <span class="bar-label">CPU</span>
        <div class="bar-track"><div class="bar-fill cpu" id="cpu-${id}" style="width:${Math.min(cpuPct,100)}%"></div></div>
        <span class="bar-value" id="cpuv-${id}">${state === 'running' ? cpuPct.toFixed(1) + '%' : '—'}</span>
      </div>
      <div class="bar-row">
        <span class="bar-label">MEM</span>
        <div class="bar-track"><div class="bar-fill mem" id="mem-${id}" style="width:${Math.min(memPct,100)}%"></div></div>
        <span class="bar-value" id="memv-${id}">${state === 'running' ? memUsage : '—'}</span>
      </div>
    </div>

    <div class="card-size">
      <div class="size-val">${formatSize(size)}</div>
      <div class="size-lbl">Tamaño</div>
    </div>
  </div>

  <div class="card-actions">
    ${canStart   ? `<button class="btn green"  onclick="containerAction('${id}','start'   )">▶ Iniciar</button>`    : ''}
    ${canStop    ? `<button class="btn red"    onclick="containerAction('${id}','stop'    )">⏹ Detener</button>`   : ''}
    ${canRestart ? `<button class="btn yellow" onclick="containerAction('${id}','restart' )">↺ Reiniciar</button>` : ''}
    <button class="btn" onclick="openLogs('${id}','${escHtml(name)}')">📋 Logs</button>
    ${state === 'running' ? `<button class="container-explore-btn" onclick="openContainerExplorer('${id}','${escHtml(name)}')" title="Explorar archivos y BD">🗂 Explorar</button>` : ''}
    <div class="btn-spacer"></div>
    <button class="btn-icon" onclick="confirmRemove('${id}','${escHtml(name)}')" title="Eliminar contenedor">🗑</button>
  </div>
</div>`;
}

async function loadContainerIp(id) {
  const el = $id('ip-' + id);
  if (!el) return;
  try {
    const r = await api.containerGetNetworkInfo(id);
    if (!r.ok || !r.networks.length) { el.textContent = '—'; return; }
    const ips = r.networks.map(n => n.ip).filter(ip => ip && ip !== '');
    el.textContent = ips.length ? ips.join(', ') : '—';
    el.title = r.networks.map(n => `${n.name}: ${n.ip}`).join('\n');
  } catch { el.textContent = '—'; }
}

async function loadWslIp(name) {
  const safeId = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const el = document.getElementById('wsl-ip-' + safeId);
  if (!el) return;
  try {
    const r = await api.wslGetNetworkInfo(name);
    if (!r.ok || !r.ips.length) { el.textContent = '—'; return; }
    const mainIp = r.ips[0].ip;
    el.textContent = mainIp;
    const portCount = r.portLines.length;
    if (portCount) {
      el.title = `IP: ${mainIp}\nGW: ${r.gateway || '?'}\n${portCount} puerto(s) en escucha`;
    }
  } catch { el.textContent = '—'; }
}

function renderContainerStats() {
  state.containers.forEach(c => {
    if (c.State !== 'running') return;
    const id    = c.ID || '';
    const stats = findStats(id, (c.Names || '').replace(/^\//,''));
    if (!stats) return;

    const cpu = parseFloat(stats.CPUPerc) || 0;
    const mem = parseFloat(stats.MemPerc) || 0;

    const cpuEl  = document.getElementById(`cpu-${id}`);
    const cpuvEl = document.getElementById(`cpuv-${id}`);
    const memEl  = document.getElementById(`mem-${id}`);
    const memvEl = document.getElementById(`memv-${id}`);

    if (cpuEl)  cpuEl.style.width  = Math.min(cpu, 100) + '%';
    if (cpuvEl) cpuvEl.textContent = cpu.toFixed(1) + '%';
    if (memEl)  memEl.style.width  = Math.min(mem, 100) + '%';
    if (memvEl) memvEl.textContent = stats.MemUsage || '—';
  });
}

function findStats(id, name) {
  // Stats keyed by full or short ID, or by container name
  return state.stats[id] ||
         state.stats[id.slice(0,12)] ||
         Object.values(state.stats).find(s =>
           s.Name === name || s.Name === '/' + name);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER — IMÁGENES
// ═══════════════════════════════════════════════════════════════════════════════
function renderImages() {
  const content = $id('images-content');
  const search  = ($id('search-images')?.value || '').toLowerCase();

  let list = state.images;
  if (search) list = list.filter(i =>
    (i.Repository || '').toLowerCase().includes(search) ||
    (i.Tag        || '').toLowerCase().includes(search));

  $id('images-count').textContent = `${list.length} imagen${list.length !== 1 ? 'es' : ''}`;

  if (!list.length) {
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">🖼️</div><p>No hay imágenes</p></div>`;
    return;
  }

  content.innerHTML = `
<table class="images-table">
  <thead>
    <tr>
      <th>Repositorio</th>
      <th>Tag</th>
      <th>ID</th>
      <th>Tamaño</th>
      <th>Creada</th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    ${list.map(img => `
    <tr>
      <td><span class="image-repo">${escHtml(img.Repository || '&lt;none&gt;')}</span></td>
      <td><span class="image-tag">${escHtml(img.Tag || 'latest')}</span></td>
      <td class="mono text-muted">${(img.ID || '').replace('sha256:','').slice(0,12)}</td>
      <td>${escHtml(img.Size || '—')}</td>
      <td class="text-muted">${escHtml(img.CreatedSince || img.CreatedAt || '—')}</td>
      <td>
        <button class="btn-icon" title="Eliminar imagen"
                onclick="removeImage('${escHtml(img.ID || '')}','${escHtml(img.Repository + ':' + img.Tag)}')">🗑</button>
      </td>
    </tr>`).join('')}
  </tbody>
</table>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER — VOLÚMENES
// ═══════════════════════════════════════════════════════════════════════════════
function renderVolumes() {
  const content = $id('volumes-content');
  const list    = state.volumes;

  $id('volumes-count').textContent = `${list.length} volumen${list.length !== 1 ? 'es' : ''}`;

  if (!list.length) {
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">💾</div><p>No hay volúmenes</p></div>`;
    return;
  }

  content.innerHTML = list.map(v => `
<div class="volume-card">
  <div class="volume-icon">💾</div>
  <div class="volume-info">
    <div class="volume-name">${escHtml(v.Name || '—')}</div>
    <div class="volume-meta">
      <span class="volume-driver">${escHtml(v.Driver || 'local')}</span>
      ${v.Mountpoint ? `&nbsp;·&nbsp; ${escHtml(v.Mountpoint)}` : ''}
    </div>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    <button class="btn-icon" title="Eliminar volumen"
            onclick="removeVolume('${escHtml(v.Name)}')">🗑</button>
  </div>
</div>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER — SIDEBAR PROJECT FILTER
// ═══════════════════════════════════════════════════════════════════════════════
function renderProjectFilter() {
  const list = $id('project-list');
  const colors = ['var(--green)','var(--blue)','var(--yellow)','var(--purple)','var(--cyan)','var(--orange)'];

  list.innerHTML = state.projects.map((p, i) => {
    const color   = colors[i % colors.length];
    const active  = state.selectedProject === p ? 'active' : '';
    const count   = state.containers.filter(c => c.composeProject === p).length;
    return `
<div class="project-filter ${active}" data-project="${escHtml(p)}"
     onclick="filterByProject('${escHtml(p)}')">
  <div class="project-dot" style="background:${color}"></div>
  <span class="project-name">${escHtml(p)}</span>
  <span style="margin-left:auto;font-size:10px;color:var(--text-3)">${count}</span>
</div>`;
  }).join('');
}

function filterByProject(proj) {
  state.selectedProject = proj;
  document.querySelectorAll('.project-filter').forEach(el => {
    el.classList.toggle('active', el.dataset.project === proj);
  });
  renderContainers();
}

function updateBadges() {
  const running = state.containers.filter(c => c.State === 'running').length;
  $id('badge-running').textContent = running;
  $id('badge-running').className   = 'nav-badge ' + (running > 0 ? 'green' : '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCIONES DE CONTENEDOR
// ═══════════════════════════════════════════════════════════════════════════════
async function containerAction(id, action) {
  const card = document.getElementById(`card-${id}`);
  if (card) {
    const btns = card.querySelectorAll('button');
    btns.forEach(b => b.disabled = true);
  }

  const labels = { start:'Iniciando', stop:'Deteniendo', restart:'Reiniciando' };
  showToast(`${labels[action] || action}…`, 'info');

  const res = await api.containerAction(id, action);

  if (res.ok) {
    showToast(`✓ ${action} exitoso`, 'success');
    setTimeout(() => refreshContainerData(), 1200);
  } else {
    showToast(`Error: ${res.error}`, 'error');
    if (card) card.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}

async function confirmRemove(id, name) {
  if (!confirm(`¿Eliminar el contenedor "${name}"?\n\nEsto no se puede deshacer.`)) return;
  const res = await api.containerAction(id, 'remove');
  if (res.ok) {
    showToast(`✓ Contenedor eliminado`, 'success');
    await refreshContainerData();
  } else {
    showToast(`Error: ${res.error}`, 'error');
  }
}

async function removeImage(id, label) {
  if (!confirm(`¿Eliminar la imagen "${label}"?`)) return;
  const res = await api.removeImage(id);
  if (res.ok) { showToast('✓ Imagen eliminada', 'success'); await refreshImages(); }
  else showToast(`Error: ${res.error}`, 'error');
}

async function removeVolume(name) {
  if (!confirm(`¿Eliminar el volumen "${name}"?\n⚠️ Se perderán los datos almacenados.`)) return;
  const res = await api.removeVolume(name);
  if (res.ok) { showToast('✓ Volumen eliminado', 'success'); await refreshVolumes(); }
  else showToast(`Error: ${res.error}`, 'error');
}

// Prune
async function pruneImages()     { await doPrune('images',     '¿Eliminar imágenes no usadas?'); }
async function pruneContainers() { await doPrune('containers', '¿Eliminar contenedores parados?'); }
async function pruneVolumes()    { await doPrune('volumes',    '¿Eliminar volúmenes huérfanos?'); }
async function pruneAll()        { await doPrune('all', '⚠️ ¿Limpiar TODO (imágenes, contenedores, volúmenes sin uso)?'); }

async function doPrune(what, msg) {
  if (!confirm(msg)) return;
  showToast('Limpiando…', 'info');
  const res = await api.pruneSystem(what);
  if (res.ok) {
    showToast('✓ Limpieza completada', 'success');
    const out = $id('prune-output');
    if (out) { out.textContent = res.data; out.style.display = 'block'; }
    await refreshAll();
  } else {
    showToast(`Error: ${res.error}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGS
// ═══════════════════════════════════════════════════════════════════════════════
function populateLogSelect() {
  const sel = $id('log-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Selecciona un contenedor —</option>';
  state.containers.forEach(c => {
    const name = (c.Names || c.ID).replace(/^\//,'');
    const opt  = document.createElement('option');
    opt.value  = c.ID;
    opt.textContent = name + (c.State !== 'running' ? ' (detenido)' : '');
    if (c.ID === cur) opt.selected = true;
    sel.appendChild(opt);
  });
}

function openLogs(id, name) {
  showTab('logs');
  $id('log-select').value = id;
  loadLogs();
}

async function loadLogs() {
  const id = $id('log-select').value;
  if (!id) return;
  const lines = $id('log-lines').value;
  const body  = $id('log-body');
  body.innerHTML = '<span style="color:var(--text-3)">Cargando logs…</span>';

  const res = await api.getLogs(id, lines === 'all' ? 5000 : parseInt(lines));
  if (res.ok) {
    body.innerHTML = colorizeLog(res.data);
    body.scrollTop = body.scrollHeight;
  } else {
    body.innerHTML = `<span class="log-err">Error: ${escHtml(res.error)}</span>`;
  }
}

function clearLogs() {
  if (currentLogSource === 'wsl') { wslLogBuffer.length = 0; $id('log-body').innerHTML = ''; }
  else $id('log-body').innerHTML = '';
}

function switchLogSource(source) {
  currentLogSource = source;
  // toggle button styles
  const btnD = document.getElementById('log-src-docker');
  const btnW = document.getElementById('log-src-wsl');
  if (btnD) { btnD.className = source === 'docker' ? 'btn blue' : 'btn'; }
  if (btnW) { btnW.className = source === 'wsl'    ? 'btn blue' : 'btn'; }
  // show/hide docker-specific controls
  const dockerCtrls = document.getElementById('log-docker-ctrls');
  if (dockerCtrls) dockerCtrls.style.display = source === 'docker' ? 'contents' : 'none';
  if (source === 'wsl') {
    renderWslLog();
  } else {
    loadLogs();
  }
}

function renderWslLog() {
  const body = $id('log-body');
  if (!body) return;
  if (!wslLogBuffer.length) {
    body.innerHTML = '<span style="color:var(--text-3)">Sin actividad WSL registrada. Ve a la pestaña WSL y realiza alguna acción.</span>';
    return;
  }
  const levelColor = { ok: 'var(--green)', err: 'var(--red)', cmd: 'var(--blue)', info: 'var(--text-2)' };
  body.innerHTML = wslLogBuffer.map(e =>
    `<div style="font-size:11px;font-family:monospace;padding:1px 0">` +
    `<span style="color:var(--text-3)">[${e.ts}]</span> ` +
    `<span style="color:${levelColor[e.level] || 'var(--text-1)'}">${escHtml(e.msg)}</span></div>`
  ).join('');
  body.scrollTop = body.scrollHeight;
}

async function toggleFollowLogs() {
  const btn = $id('btn-follow');
  if (state.logsStreamId) {
    api.killStream(state.logsStreamId);
    state.logsStreamId = null;
    state.followLogs   = false;
    btn.className      = 'btn blue';
    btn.textContent    = '▶ Follow';
  } else {
    const id = $id('log-select').value;
    if (!id) { showToast('Selecciona un contenedor primero', 'info'); return; }
    state.logsStreamId = 'logs-' + Date.now();
    state.followLogs   = true;
    btn.className      = 'btn red';
    btn.textContent    = '⏹ Seguir';
    $id('log-body').innerHTML = '';
    api.streamLogs(id, state.logsStreamId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFER — PACK (Container Picker + Dynamic Bundle)
// ═══════════════════════════════════════════════════════════════════════════════

// Scanned project data
const packState = {
  services:    [],  // [{name, image, volumes, ports, running, containerName, checked}]
  projectPath: '',
};

async function browsePackProject() {
  const dir = await api.openFolder();
  if (dir) {
    $id('pack-project-path').value = dir;
    // Auto-scan on selection
    await scanPackProject();
  }
}

async function browsePackOutput() {
  const dir = await api.openFolder();
  if (dir) $id('pack-output-dir').value = dir;
}

async function scanPackProject() {
  const projectPath = $id('pack-project-path').value.trim();
  if (!projectPath) { showToast('Selecciona el directorio del proyecto primero', 'warn'); return; }

  const btn = $id('pack-scan-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Escaneando…'; }

  const res = await api.dockerScanProject({ projectPath }).catch(e => ({ ok: false, error: e.message }));

  if (btn) { btn.disabled = false; btn.textContent = '🔍 Escanear'; }

  if (!res.ok) {
    showToast('Error: ' + (res.error || 'No se pudo escanear'), 'error', 5000);
    return;
  }

  packState.projectPath = projectPath;
  packState.services    = res.services.map(s => ({ ...s, checked: true }));

  _packRenderTable();
  ['pack-step-2','pack-step-3','pack-step-4'].forEach(id => {
    const el = $id(id); if (el) el.style.display = '';
  });

  if (!res.composePath) {
    showToast('No se encontró docker-compose.yml — puedes añadir contenedores manualmente', 'warn', 5000);
  } else {
    showToast(`✓ ${res.services.length} servicio(s) detectados en ${res.composePath.split(/[\/]/).pop()}`, 'ok', 4000);
  }
}

function _packRenderTable() {
  const tbody = $id('pack-container-tbody');
  if (!tbody) return;

  const anyRunning = packState.services.some(s => s.running && s.checked);
  const warnEl = $id('pack-running-warn');
  if (warnEl) warnEl.style.display = anyRunning ? 'flex' : 'none';

  tbody.innerHTML = packState.services.map((s, i) => {
    const stateHtml = s.running
      ? '<span class="pack-status-running">● Activo</span>'
      : s.status === 'Not created'
        ? '<span class="pack-status-missing">✗ Sin contenedor</span>'
        : '<span class="pack-status-stopped">○ Detenido</span>';
    const volsHtml = (s.volumes||[]).length
      ? `<span class="pack-vol-list">${escHtml((s.volumes||[]).join(', '))}</span>`
      : '<span style="color:var(--text-3)">—</span>';
    const isCustom = s._custom ? `<button class="btn btn-sm" onclick="packRemoveRow(${i})" title="Eliminar">✕</button>` : '';
    return `<tr class="${s.running ? 'pack-row-running' : ''}">
      <td><input type="checkbox" ${s.checked ? 'checked' : ''} onchange="packToggleRow(${i}, this.checked)"></td>
      <td><strong>${escHtml(s.name)}</strong>${s.buildsLocally ? ' <span class="pack-badge-build" title="Imagen construida localmente">BUILD</span>' : ''}${isCustom}</td>
      <td><code style="font-size:11px">${escHtml(s.image||'—')}</code></td>
      <td style="font-size:11px">${volsHtml}</td>
      <td>${stateHtml}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="text-align:center;padding:12px;color:var(--text-2)">Sin servicios detectados — usa "＋ Añadir manual"</td></tr>';

  // Update select-all checkbox
  const allChk = $id('pack-check-all');
  if (allChk) {
    const allChecked = packState.services.every(s => s.checked);
    const someChecked = packState.services.some(s => s.checked);
    allChk.checked = allChecked;
    allChk.indeterminate = !allChecked && someChecked;
  }
}

function packToggleRow(i, checked) {
  if (packState.services[i]) packState.services[i].checked = checked;
  _packRenderTable();
}

function packSelectAll(checked) {
  packState.services.forEach(s => s.checked = checked);
  _packRenderTable();
}

function packRemoveRow(i) {
  packState.services.splice(i, 1);
  _packRenderTable();
}

function packAddCustom() {
  ['pack-add-name','pack-add-image','pack-add-volumes'].forEach(id => {
    const el = $id(id); if (el) el.value = '';
  });
  const modal = $id('pack-add-modal');
  if (modal) modal.style.display = 'block';
}

function packAddCustomConfirm() {
  const name   = $id('pack-add-name')?.value.trim();
  const image  = $id('pack-add-image')?.value.trim();
  const volsRaw = $id('pack-add-volumes')?.value.trim();
  if (!name || !image) { showToast('Nombre e imagen son obligatorios', 'warn'); return; }
  const volumes = volsRaw ? volsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];
  packState.services.push({ name, image, volumes, ports: [], running: false, status: 'Manual', checked: true, _custom: true });
  $id('pack-add-modal').style.display = 'none';
  _packRenderTable();
  showToast(`✓ Añadido: ${name}`, 'ok', 2000);
}

async function packStopRunning() {
  const running = packState.services.filter(s => s.running && s.checked && s.containerName);
  if (!running.length) { showToast('No hay contenedores activos seleccionados', 'info'); return; }
  if (!confirm(`¿Detener ${running.length} contenedor(es)?\n${running.map(s=>s.containerName).join(', ')}`)) return;
  const res = await api.dockerStopByNames({ names: running.map(s => s.containerName) })
    .catch(() => ({ ok: false }));
  if (res.ok) {
    running.forEach(s => { s.running = false; s.status = 'Stopped'; });
    _packRenderTable();
    showToast(`✓ Contenedores detenidos`, 'ok', 3000);
  } else {
    showToast('Error al detener contenedores: ' + (res.error || ''), 'error');
  }
}

async function runPackBundle() {
  const selected = packState.services.filter(s => s.checked);
  if (!selected.length) { showToast('Selecciona al menos un contenedor', 'warn'); return; }
  if (!packState.projectPath) { showToast('Selecciona el directorio del proyecto', 'warn'); return; }

  const runningSelected = selected.filter(s => s.running);
  if (runningSelected.length > 0) {
    const proceed = confirm(
      `⚠ ${runningSelected.length} contenedor(es) siguen activos.\n` +
      'Un backup con contenedores activos puede tener datos inconsistentes.\n\n' +
      '¿Continuar de todos modos?'
    );
    if (!proceed) return;
  }

  const outputDir = $id('pack-output-dir')?.value.trim() || '';
  const skipVols  = $id('pack-no-volumes')?.checked || false;
  const openAfter = $id('pack-open-folder')?.checked || false;

  showConsole('pack');
  clearConsole('pack-output');
  appendConsole('pack-output', `▶ Iniciando bundle de ${selected.length} servicio(s)\n\n`);

  state.packStreamId = 'pack-' + Date.now();
  $id('pack-kill-btn').disabled = false;

  // Store for stream end handler
  state._packOpenAfter = openAfter;

  api.dockerBuildBundle({
    projectPath: packState.projectPath,
    outputDir,
    services: selected.map(s => ({ name: s.name, image: s.image, volumes: s.volumes || [] })),
    options:  { skipVolumes: skipVols },
    streamId: state.packStreamId,
  });
}

// Keep old runPack as alias (in case any other code calls it)
async function runPack() { return runPackBundle(); }

function killPack() {
  if (state.packStreamId) {
    api.killStream(state.packStreamId);
    state.packStreamId = null;
    appendConsole('pack-output', '\n[Proceso detenido por el usuario]\n', 'err');
    $id('pack-kill-btn').disabled = true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFER — DEPLOY
// ═══════════════════════════════════════════════════════════════════════════════
async function browseDeploy() {
  const file = await api.openFile({
    filters: [{ name: 'Bundle', extensions: ['gz','tar','tar.gz','zip'] }],
    title: 'Selecciona el bundle',
  });
  if (!file) return;
  $id('deploy-bundle-path').value = file;

  // Auto-detect deploy script in same folder or extracted location
  const dir = file.replace(/[/\\][^/\\]+$/, '');   // dirname
  const isWin = (await api.platform()) === 'win32';
  const scriptName = isWin ? 'deploy.ps1' : 'deploy.sh';
  const candidate  = dir + (isWin ? '\\' : '/') + scriptName;
  const exists     = await api.fileExists(candidate);
  if (exists) $id('deploy-script-path').value = candidate;
}

async function browseDeployScript() {
  const file = await api.openFile({
    filters: [
      { name: 'Shell Script', extensions: ['sh','ps1'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  });
  if (file) $id('deploy-script-path').value = file;
}

async function runDeploy() {
  const scriptPath = $id('deploy-script-path').value.trim();
  const bundlePath = $id('deploy-bundle-path').value.trim();

  if (!scriptPath) { showToast('Selecciona o detecta el script de despliegue', 'info'); return; }
  if (!bundlePath) { showToast('Selecciona el archivo bundle', 'info'); return; }

  const args = [];
  const port = $id('deploy-port').value;
  if (port && port !== '3000') { args.push('--port'); args.push(port); }
  if ($id('deploy-skip-volumes').checked) args.push('--skip-volumes');

  showConsole('deploy');
  clearConsole('deploy-output');
  appendConsole('deploy-output', `▶ Ejecutando: ${scriptPath} ${args.join(' ')}\n\n`);

  state.deployStreamId = 'deploy-' + Date.now();
  $id('deploy-kill-btn').disabled = false;
  const cwd = scriptPath.replace(/[/\\][^/\\]+$/, '');
  api.runScript(scriptPath, args, state.deployStreamId, cwd);
}

function killDeploy() {
  if (state.deployStreamId) {
    api.killStream(state.deployStreamId);
    state.deployStreamId = null;
    appendConsole('deploy-output', '\n[Proceso detenido por el usuario]\n', 'err');
    $id('deploy-kill-btn').disabled = true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING — Listener único para pack, deploy y logs
// ═══════════════════════════════════════════════════════════════════════════════
function setupStreamListeners() {
  api.onStreamData(({ streamId, data }) => {
    // Logs follow
    if (streamId === state.logsStreamId) {
      appendLog(data);
      return;
    }
    // Pack
    if (streamId === state.packStreamId) {
      appendConsole('pack-output', data);
      return;
    }
    // Deploy
    if (streamId === state.deployStreamId) {
      appendConsole('deploy-output', data);
      return;
    }
    // SCP transfer
    if (streamId === state.scpStreamId) {
      appendConsole('scp-output', data);
      return;
    }
    // Cloud push
    if (streamId === state.cloudStreamId) {
      appendConsole('cloud-output', data);
      return;
    }
    // Remote test
    if (streamId?.startsWith('ssh-test-')) {
      appendConsole('remote-output', data);
      return;
    }
    // SSH terminal
    if (sshHandleStreamData(streamId, data)) return;
    // Tool auto-install stream
    if (wslHandleToolInstallStream(streamId, data)) return;
    // Export progress stream
    if (streamId === wslState._exportStreamId) { wslLog(data.replace(/\r?\n/g,''), 'info'); return; }
    // WSL streams (SSH, mount, transfer)
    wslHandleStreamData(streamId, data);
  });

  api.onStreamEnd((payload) => {
    const { streamId, code } = payload;
    if (streamId === state.logsStreamId) {
      state.logsStreamId = null; state.followLogs = false;
      const btn = $id('btn-follow');
      if (btn) { btn.className = 'btn blue'; btn.textContent = '▶ Follow'; }
    }
    if (streamId === state.packStreamId) {
      state.packStreamId = null;
      const btn = $id('pack-kill-btn');
      if (btn) btn.disabled = true;
      const ok = code === 0;
      const msg = ok ? '\n✅ Bundle creado exitosamente.' : `\n❌ Error — código ${code}`;
      appendConsole('pack-output', msg, ok ? 'ok' : 'err');
      if (ok) {
        const filePath = payload?.filePath || '';
        const fileName = filePath ? filePath.replace(/.*[\/]/, '') : '';
        showToast('✅ Bundle listo' + (fileName ? ': ' + fileName : ''), 'success', 6000);
        if (state._packOpenAfter !== false && filePath) {
          const dir = filePath.replace(/[\/][^\/]+$/, '');
          api.wslOpenFolder(dir).catch(() => {});
        }
        setTimeout(refreshAll, 2000);
      } else {
        showToast('✗ Error al crear el bundle', 'error');
      }
    }
    if (streamId === state.deployStreamId) {
      state.deployStreamId = null;
      const btn = $id('deploy-kill-btn');
      if (btn) btn.disabled = true;
      const msg = code === 0 ? '\n✓ Despliegue completado.\n' : `\n✗ Proceso terminó con código ${code}\n`;
      appendConsole('deploy-output', msg, code === 0 ? 'ok' : 'err');
      if (code === 0) { showToast('✓ Proyecto desplegado', 'success'); setTimeout(refreshAll, 3000); }
      else showToast('✗ El despliegue terminó con error', 'error');
    }
    if (streamId === state.scpStreamId) {
      state.scpStreamId = null;
      const msg = code === 0 ? '\n✓ Transferencia completada.\n' : `\n✗ SCP terminó con código ${code}\n`;
      appendConsole('scp-output', msg, code === 0 ? 'ok' : 'err');
      if (code === 0) showToast('✓ Bundle transferido', 'success');
      else showToast('✗ Error en la transferencia', 'error');
    }
    if (streamId === state.cloudStreamId) {
      state.cloudStreamId = null;
      const msg = code === 0 ? '\n✓ Push completado exitosamente.\n' : `\n✗ Proceso terminó con código ${code}\n`;
      appendConsole('cloud-output', msg, code === 0 ? 'ok' : 'err');
      if (code === 0) showToast('✓ Imagen subida al registry', 'success');
      else showToast('✗ Error en el push', 'error');
    }
    if (streamId?.startsWith('ssh-test-')) {
      state.cloudStreamId = null;
      const msg = code === 0 ? '\n✓ Conexión SSH exitosa.\n' : `\n✗ Falló la prueba SSH (código ${code})\n`;
      appendConsole('remote-output', msg, code === 0 ? 'ok' : 'err');
    }
    // Export stream end (filePath passed back from main process)
    if (wslHandleExportStreamEnd(streamId, code, payload?.filePath)) return;
    // SSH terminal session end
    sshHandleStreamEnd(streamId, code);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHEQUEO DE SEGURIDAD AL INICIO
// ═══════════════════════════════════════════════════════════════════════════════

function showSecurityBanner(msg) {
  const banner = $id('security-banner');
  const msgEl  = $id('security-banner-msg');
  if (!banner || !msgEl) return;
  msgEl.textContent = '⚠️  ' + msg;
  banner.classList.remove('hidden');
}

function dismissSecurityBanner() {
  const banner = $id('security-banner');
  if (banner) banner.classList.add('hidden');
}

async function runStartupSecurityCheck() {
  try {
    const [updatesRes, auditRes] = await Promise.all([
      api.checkUpdates().catch(() => null),
      api.auditDeps   ? api.auditDeps().catch(() => null) : Promise.resolve(null),
    ]);

    const outdated = (updatesRes?.packages || []).filter(p => p.isOutdated).length;
    const vulns    = auditRes?.high ?? 0;
    const totalV   = auditRes?.total ?? 0;

    if (vulns > 0) {
      showSecurityBanner(
        `Se detectaron ${vulns} vulnerabilidad(es) crítica(s)/alta(s) en dependencias. Actualiza desde Configuración > Dependencias.`
      );
    } else if (totalV > 0) {
      showSecurityBanner(
        `npm audit encontró ${totalV} advertencia(s) en dependencias. Revisa en Configuración > Dependencias.`
      );
    } else if (outdated > 0) {
      showSecurityBanner(
        `${outdated} dependencia(s) desactualizadas. Actualiza desde Configuración > Dependencias.`
      );
    }
  } catch { /* silencioso — no bloquear la UI */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
// GESTIÓN DE DEPENDENCIAS
// ═══════════════════════════════════════════════════════════════════════════════

async function loadAppVersionInfo() {
  const el = $id('app-version-info');
  if (!el) return;
  const res = await api.getAppVersion().catch(() => null);
  if (!res?.ok) { el.innerHTML = '<span class="deps-info-loading">Error al obtener versiones</span>'; return; }

  const rows = [
    ['Aplicación',    res.appVersion ],
    ['Electron',      res.electron   ],
    ['Node.js',       res.node       ],
    ['Chromium',      res.chromium   ],
    ['Plataforma',    res.platform   ],
  ];
  el.innerHTML = rows.map(([k, v]) => `
    <span class="deps-info-label">${k}</span>
    <span class="deps-info-value">${v || '—'}</span>
  `).join('');
}

async function checkDependencyUpdates() {
  const status = $id('deps-check-status');
  const wrap   = $id('deps-table-wrap');
  const tbody  = $id('deps-table-body');
  if (!status || !wrap || !tbody) return;

  status.textContent = '⏳ Verificando…';
  status.style.color  = 'var(--text-2)';

  const res = await api.checkUpdates().catch(() => null);
  if (!res?.ok) {
    status.textContent = '✗ Error al verificar paquetes';
    status.style.color  = 'var(--red)';
    return;
  }

  const packages = res.packages || [];

  if (packages.length === 0) {
    status.textContent = '✓ Todas las dependencias están actualizadas';
    status.style.color  = 'var(--green)';
    wrap.style.display  = 'none';
    return;
  }

  const outdated = packages.filter(p => p.isOutdated);
  status.textContent = outdated.length > 0
    ? `⚠️ ${outdated.length} paquete(s) desactualizado(s)`
    : '✓ Todo actualizado';
  status.style.color = outdated.length > 0 ? 'var(--yellow)' : 'var(--green)';

  tbody.innerHTML = '';
  packages.forEach(pkg => {
    const isOut = pkg.isOutdated;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="deps-pkg-name">${escHtml(pkg.name)}</span></td>
      <td><span class="deps-version">${escHtml(pkg.current || '—')}</span></td>
      <td><span class="${isOut ? 'deps-latest' : 'deps-version'}">${escHtml(pkg.latest || '—')}</span></td>
      <td><span class="${isOut ? 'deps-badge-out' : 'deps-badge-ok'}">${isOut ? 'Desactualizado' : 'Al día'}</span></td>
      <td>
        ${isOut ? `<button class="btn-icon" onclick="updateSingleDep('${escHtml(pkg.name)}','${escHtml(pkg.latest)}')" title="Actualizar a ${escHtml(pkg.latest)}">⬆️</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });

  wrap.style.display = '';
  $id('deps-update-all-btn').style.display = outdated.length > 0 ? '' : 'none';
}

async function updateSingleDep(name, version) {
  const status = $id('deps-update-status');
  if (status) { status.textContent = `⏳ Actualizando ${name}…`; status.style.color = 'var(--text-2)'; }
  const res = await api.updatePackage(name, version).catch(() => null);
  if (!res?.ok) {
    if (status) { status.textContent = `✗ Error: ${res?.error || 'desconocido'}`; status.style.color = 'var(--red)'; }
    showToast(`Error al actualizar ${name}`, 'error');
    return;
  }
  showToast(`✓ ${name}@${version} actualizado`, 'success');
  if (status) { status.textContent = `✓ ${name} actualizado`; status.style.color = 'var(--green)'; }
  await checkDependencyUpdates();
}

async function updateAllDependencies() {
  const status = $id('deps-update-status');
  const tbody  = $id('deps-table-body');
  if (!tbody) return;

  const outdatedBtns = tbody.querySelectorAll('button[onclick^="updateSingleDep"]');
  const toUpdate = [];
  outdatedBtns.forEach(btn => {
    const m = btn.getAttribute('onclick').match(/updateSingleDep\('([^']+)','([^']+)'\)/);
    if (m) toUpdate.push({ name: m[1], version: m[2] });
  });

  if (toUpdate.length === 0) { showToast('No hay paquetes para actualizar', 'info'); return; }

  if (status) { status.textContent = `⏳ Actualizando ${toUpdate.length} paquete(s)…`; status.style.color = 'var(--text-2)'; }

  for (const pkg of toUpdate) {
    await api.updatePackage(pkg.name, pkg.version).catch(() => null);
  }
  showToast(`✓ Actualizados ${toUpdate.length} paquetes`, 'success');
  if (status) { status.textContent = `✓ Actualización completada`; status.style.color = 'var(--green)'; }
  await checkDependencyUpdates();
}

// ═══════════════════════════════════════════════════════════════════════════════
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('dm-settings') || '{}');
    Object.assign(state.settings, s);
  } catch {}
  $id('cfg-refresh').value       = state.settings.refreshInterval;
  $id('cfg-autorefresh').checked = state.settings.autoRefresh;
}

function saveSettings() {
  state.settings.refreshInterval = parseInt($id('cfg-refresh').value) || 15;
  state.settings.autoRefresh     = $id('cfg-autorefresh').checked;
  localStorage.setItem('dm-settings', JSON.stringify(state.settings));
  startAutoRefresh();
  showToast('✓ Configuración guardada', 'success');
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVEGACIÓN DE TABS
// ═══════════════════════════════════════════════════════════════════════════════
function showTab(tab) {
  state.activeTab = tab;

  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.add('hidden');
    el.style.display = '';
  });
  document.querySelectorAll('.nav-item[data-tab]').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });

  const el = $id(`tab-${tab}`);
  if (el) {
    el.classList.remove('hidden');
    if (tab === 'logs') el.style.display = 'flex';
  }

  // Lazy load when switching tabs
  if (tab === 'images')   renderImages();
  if (tab === 'volumes')  renderVolumes();
  if (tab === 'settings') loadAppVersionInfo();
  if (tab === 'wsl')      refreshWsl();
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function showConsole(prefix) {
  const wrap = $id(`${prefix}-console-wrap`);
  if (wrap) wrap.style.display = 'block';
}

function clearConsole(id) {
  const el = $id(id);
  if (el) el.innerHTML = '';
}

function appendConsole(id, text, type = '') {
  const el = $id(id);
  if (!el) return;
  const span   = document.createElement('span');
  const cleaned = stripAnsi(text);
  span.textContent = cleaned;
  if (type === 'err') span.className = 'console-line-err';
  if (type === 'ok')  span.className = 'console-line-ok';
  if (type === 'warn')span.className = 'console-line-warn';
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOG HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function appendLog(text) {
  const body = $id('log-body');
  if (!body) return;
  body.insertAdjacentHTML('beforeend', colorizeLog(text));
  body.scrollTop = body.scrollHeight;
}

function colorizeLog(raw) {
  return stripAnsi(raw)
    .split('\n')
    .map(line => {
      const safe = escHtml(line);
      if (/\bERROR\b|\bCRITICAL\b/i.test(line))  return `<span class="log-err">${safe}</span>`;
      if (/\bWARN(ING)?\b/i.test(line))           return `<span class="log-warn">${safe}</span>`;
      if (/\bINFO\b|\bDEBUG\b/i.test(line))       return `<span class="log-info">${safe}</span>`;
      // Highlight timestamp at start
      return safe.replace(/^(\d{4}-\d{2}-\d{2}T[\d:.Z+]+)\s/, '<span class="log-ts">$1</span> ');
    })
    .join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════════
function showToast(msg, type = 'info', duration = 3500) {
  const container = $id('toasts');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${escHtml(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .4s'; }, duration - 400);
  setTimeout(() => toast.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════════
function $id(id) { return document.getElementById(id); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Remover códigos ANSI de color
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKH]/g, '');
}

function formatPorts(raw) {
  if (!raw) return '';
  return raw.split(',').map(p => p.trim())
    .filter(Boolean)
    .map(p => p.replace(/^0\.0\.0\.0:/,''))
    .slice(0, 3)
    .join(', ');
}

function countMappedPorts(raw) {
  if (!raw) return 0;
  // Cuenta solo puertos con mapeo host (contienen ->)
  return raw.split(',').filter(p => p.includes('->')).length;
}

function formatSize(raw) {
  if (!raw || raw === '—') return '—';
  // Size field: "125B (virtual 450MB)"
  const m = raw.match(/([\d.]+\s*[KMGTP]?B)/i);
  return m ? m[1] : raw;
}

function sumBytes(arr) {
  // Attempt to total size strings like "1.5GB", "500MB"
  let totalMB = 0;
  arr.forEach(s => {
    if (!s) return;
    const m = String(s).match(/([\d.]+)\s*(B|KB|MB|GB|TB)?/i);
    if (!m) return;
    const n = parseFloat(m[1]);
    const u = (m[2] || 'B').toUpperCase();
    const factor = { 'B':1/1048576, 'KB':1/1024, 'MB':1, 'GB':1024, 'TB':1048576 };
    totalMB += n * (factor[u] || 1);
  });
  if (totalMB === 0) return '—';
  if (totalMB >= 1024) return (totalMB / 1024).toFixed(1) + ' GB';
  return totalMB.toFixed(0) + ' MB';
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAT CARDS CLICKABLES
// ═══════════════════════════════════════════════════════════════════════════════
function filterByStat(type) {
  showTab('containers');
  const sel = $id('filter-state');
  if (type === 'running' || type === 'exited') {
    sel.value = type;
  } else {
    sel.value = 'all';
  }
  renderContainers();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MENÚ CONTEXTUAL
// ═══════════════════════════════════════════════════════════════════════════════
function setupContextMenu() {
  const grid = $id('container-grid');
  if (!grid) return;

  // Event delegation: captura clic derecho en cualquier card
  document.addEventListener('contextmenu', e => {
    const card = e.target.closest('.container-card');
    if (!card) return;
    e.preventDefault();

    const id   = card.id.replace('card-', '');
    const cont = state.containers.find(c => c.ID === id);
    if (!cont) return;

    state.ctxContainer = cont;
    showContextMenu(e.clientX, e.clientY, cont);
  });
}

function showContextMenu(x, y, cont) {
  const menu = $id('ctx-menu');
  if (!menu) return;

  const isRunning = cont.State === 'running';
  const isStopped = cont.State === 'exited';

  // Habilitar/deshabilitar según estado
  menu.querySelector('[data-action="start"]').classList.toggle('disabled', isRunning);
  menu.querySelector('[data-action="stop"]').classList.toggle('disabled', isStopped);
  menu.querySelector('[data-action="restart"]').classList.toggle('disabled', isStopped);
  const exploreItem = menu.querySelector('[data-action="explore"]');
  if (exploreItem) exploreItem.classList.toggle('disabled', !isRunning);

  // Posicionar
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.classList.remove('hidden');

  // Asegurar que no salga de pantalla
  const rect = menu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  menu.style.left = (x - rect.width)  + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top  = (y - rect.height) + 'px';

  // Bind actions
  menu.querySelectorAll('.ctx-item').forEach(item => {
    item.onclick = (e) => {
      e.stopPropagation();
      handleCtxAction(item.dataset.action, cont);
      hideContextMenu();
    };
  });
}

function hideContextMenu() {
  const menu = $id('ctx-menu');
  if (menu) menu.classList.add('hidden');
}

async function handleCtxAction(action, cont) {
  const id   = cont.ID;
  const name = (cont.Names || id).replace(/^\//,'');

  switch (action) {
    case 'start':
    case 'stop':
    case 'restart':
      await containerAction(id, action);
      break;
    case 'logs':
      openLogs(id, name);
      break;
    case 'copy-id':
      navigator.clipboard.writeText(id);
      showToast(`ID copiado: ${id.slice(0,12)}`, 'info', 2000);
      break;
    case 'copy-name':
      navigator.clipboard.writeText(name);
      showToast(`Nombre copiado: ${name}`, 'info', 2000);
      break;
    case 'remove':
      await confirmRemove(id, name);
      break;
    case 'explore':
      openContainerExplorer(id, name);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REMOTO — CONEXIÓN DOCKER
// ═══════════════════════════════════════════════════════════════════════════════
async function connectRemote() {
  const host  = $id('remote-host').value.trim();
  const user  = $id('remote-user').value.trim();
  const proto = document.querySelector('input[name="remote-proto"]:checked')?.value || 'ssh';

  if (!host) { showToast('Ingresa el host del servidor', 'info'); return; }

  let dockerHost;
  if (proto === 'ssh')       dockerHost = `ssh://${user ? user + '@' : ''}${host}`;
  else if (proto === 'tcp')  dockerHost = `tcp://${host}:2376`;
  else                       dockerHost = `tcp://${host}:2375`;

  showRemoteConsole(`Conectando a ${dockerHost}…\n`);

  const res = await api.remoteConnect({ host: dockerHost });
  if (res.ok) {
    showRemoteConsole(`✓ Conectado a ${dockerHost}\n  Docker ${res.version}\n`, 'ok');
    updateRemoteBadge(host);
    showToast(`✓ Conectado a ${host}`, 'success');
    await refreshAll();
  } else {
    showRemoteConsole(`✗ Error: ${res.error}\n`, 'err');
    showToast(`Error de conexión: ${res.error}`, 'error');
  }
}

async function disconnectRemote() {
  await api.remoteDisconnect();
  updateRemoteBadge(null);
  showToast('Desconectado — usando Docker local', 'info');
  await refreshAll();
}

async function testRemote() {
  const host = $id('remote-host').value.trim();
  const user = $id('remote-user').value.trim();
  if (!host) { showToast('Ingresa el host primero', 'info'); return; }
  showRemoteConsole(`Probando conexión SSH a ${user ? user + '@' : ''}${host}…\n`);

  // Simple SSH test using the existing SCP stream infrastructure
  const streamId = 'ssh-test-' + Date.now();
  state.cloudStreamId = streamId;
  api.runCloudCommand(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${user ? user + '@' : ''}${host} docker version`, streamId);
}

function showRemoteConsole(text, type) {
  const wrap = $id('remote-console-wrap');
  if (wrap) wrap.style.display = 'block';
  appendConsole('remote-output', text, type);
}

function updateRemoteBadge(host) {
  const badge    = $id('remote-status-badge');
  const statCard = $id('s-remote-card');
  const hostEl   = $id('s-remote-host');
  if (host) {
    if (badge)    { badge.textContent = `🌐 ${host}`; badge.style.background = 'rgba(78,201,148,.2)'; badge.style.color = 'var(--green)'; }
    if (statCard) statCard.style.display = '';
    if (hostEl)   hostEl.textContent = host;
  } else {
    if (badge)    { badge.textContent = '⚫ Local'; badge.style.background = ''; badge.style.color = ''; }
    if (statCard) statCard.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCP — TRANSFERENCIA POR RED
// ═══════════════════════════════════════════════════════════════════════════════
async function browseScpBundle() {
  const f = await api.openFile({ filters: [{ name: 'Bundle', extensions: ['gz'] }] });
  if (f) $id('scp-bundle').value = f;
}

function runScpTransfer() {
  const bundle     = $id('scp-bundle').value.trim();
  const host       = $id('scp-host').value.trim();
  const user       = $id('scp-user').value.trim();
  const port       = parseInt($id('scp-port').value) || 22;
  const remotePath = $id('scp-path').value.trim() || '/tmp/';

  if (!bundle) { showToast('Selecciona el bundle a transferir', 'info'); return; }
  if (!host)   { showToast('Ingresa el host destino', 'info'); return; }
  if (!user)   { showToast('Ingresa el usuario SSH', 'info'); return; }

  const wrap = $id('scp-console-wrap');
  if (wrap) wrap.style.display = 'block';
  clearConsole('scp-output');
  appendConsole('scp-output', `▶ Enviando ${bundle}\n  → ${user}@${host}:${remotePath} (puerto ${port})\n\n`);

  state.scpStreamId = 'scp-' + Date.now();
  api.scpTransfer({ bundlePath: bundle, host, user, remotePath, port }, state.scpStreamId);
}

function killScp() {
  if (state.scpStreamId) {
    api.killStream(state.scpStreamId);
    appendConsole('scp-output', '\n[Transferencia detenida]\n', 'err');
    state.scpStreamId = null;
  }
}

function showFtpHelp() {
  const bundle = $id('scp-bundle').value.trim() || 'edificio-bundle.tar.gz';
  const msg = `Instrucciones FTP:\n\n1. Abre FileZilla o WinSCP\n2. Conéctate al servidor\n3. Arrastra el archivo:\n   ${bundle}\n   a la carpeta /opt/docker/ del servidor\n4. Luego en el servidor ejecuta:\n   tar xzf ${bundle} && bash */deploy.sh`;
  alert(msg);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUD PUSH
// ═══════════════════════════════════════════════════════════════════════════════
let cloudCommands = '';

function selectCloud(provider) {
  state.selectedCloud   = provider;
  state.cloudRegistryCreds = null;   // reset auth on provider change

  document.querySelectorAll('.cloud-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.cloud-btn.${provider}`);
  if (btn) btn.classList.add('active');

  $id('cloud-config').style.display = 'block';
  $id('cloud-provider-label').textContent = providerLabel(provider);

  // Mostrar solo los campos del proveedor elegido
  ['azure','aws','dockerhub','huawei','vps'].forEach(p => {
    const el = $id(`auth-fields-${p}`);
    if (el) el.style.display = p === provider ? '' : 'none';
  });

  // Ocultar explorador y resetear badge hasta que conecte
  const explorer = $id('cloud-explorer');
  if (explorer) explorer.style.display = 'none';
  setCloudAuthBadge('', '');
  $id('cloud-auth-status').textContent = '';
  const discBtn = $id('cloud-disconnect-btn');
  if (discBtn) discBtn.style.display = 'none';

  // Poblar chips de proyectos locales
  rebuildCloudProjChips();
  populateCloudImageDropdown();
  renderCloudQueue();
}

function rebuildCloudProjChips() {
  const projFilter = $id('cloud-proj-filter');
  if (!projFilter) return;
  const projs = [...new Set(
    state.images
      .filter(i => i.Repository && i.Repository !== '<none>')
      .map(i => {
        const parts = (i.Repository || '').split('/');
        return parts.length > 1 ? parts[0] : '__root__';
      })
  )].filter(Boolean);

  projFilter.innerHTML =
    `<span style="font-size:11px;color:var(--text-3)">Proyecto:</span>
     <button class="cloud-proj-chip active" data-proj="all" onclick="filterCloudProj('all')">Todos</button>`;

  projs.forEach(p => {
    const chip = document.createElement('button');
    chip.className = 'cloud-proj-chip';
    chip.dataset.proj = p;
    chip.textContent = p === '__root__' ? '(raíz)' : p;
    chip.onclick = () => filterCloudProj(p);
    projFilter.appendChild(chip);
  });
  state.cloudProjFilter = 'all';
}

function filterCloudProj(proj) {
  state.cloudProjFilter = proj;
  document.querySelectorAll('.cloud-proj-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.proj === proj);
  });
  populateCloudImageDropdown();
}

function populateCloudImageDropdown() {
  const sel = $id('cloud-image');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Selecciona imagen —</option>';

  const proj = state.cloudProjFilter;
  state.images
    .filter(img => {
      if (img.Repository === '<none>') return false;
      if (proj === 'all') return true;
      const parts = (img.Repository || '').split('/');
      const imgProj = parts.length > 1 ? parts[0] : '__root__';
      return imgProj === proj;
    })
    .forEach(img => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ repo: img.Repository, tag: img.Tag, size: img.Size });
      opt.textContent = `${img.Repository}:${img.Tag}  · ${img.Size}`;
      sel.appendChild(opt);
    });
}

function addCloudImage() {
  const sel = $id('cloud-image');
  if (!sel || !sel.value) { showToast('Selecciona una imagen primero', 'info'); return; }

  let data;
  try { data = JSON.parse(sel.value); } catch { return; }

  // Evitar duplicados
  const key = `${data.repo}:${data.tag}`;
  if (state.cloudImages.find(i => `${i.repo}:${i.tag}` === key)) {
    showToast('Esa imagen ya está en cola', 'info', 2000);
    return;
  }

  // Tag destino por defecto = nombre de imagen sin registry prefix
  const nameParts = data.repo.split('/');
  const shortName = nameParts[nameParts.length - 1];
  data.destTag = `${shortName}:${data.tag}`;

  state.cloudImages.push(data);
  renderCloudQueue();
  sel.value = '';
}

function removeCloudImage(idx) {
  state.cloudImages.splice(idx, 1);
  renderCloudQueue();
}

function renderCloudQueue() {
  const queue = $id('cloud-queue');
  const empty = $id('cloud-queue-empty');
  if (!queue) return;

  // Remove old rows (keep empty placeholder)
  queue.querySelectorAll('.cloud-queue-row').forEach(r => r.remove());

  if (state.cloudImages.length === 0) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  state.cloudImages.forEach((img, idx) => {
    const row = document.createElement('div');
    row.className = 'cloud-queue-row';
    row.innerHTML = `
      <span class="cloud-queue-name">${img.repo}:${img.tag}</span>
      <span class="cloud-queue-size">${img.size}</span>
      <span class="cloud-queue-tag">
        <input value="${escHtml(img.destTag)}" placeholder="repo/nombre:tag"
               oninput="state.cloudImages[${idx}].destTag=this.value"
               title="Tag de destino en el registry">
      </span>
      <span class="cloud-queue-rm" onclick="removeCloudImage(${idx})" title="Quitar">✕</span>
    `;
    queue.appendChild(row);
  });
}

function providerLabel(p) {
  return { azure:'Azure Container Registry', aws:'AWS ECR', dockerhub:'Docker Hub', huawei:'Huawei SWR', vps:'VPS / Servidor propio' }[p] || p;
}

// ─── helpers de sync campos auth → hidden inputs ────────────────────────────
function syncRegistryHost(val) { $id('cloud-registry').value = val; }
function syncVpsRegistry() {
  const host = $id('vps-host-auth')?.value.trim() || '';
  const port = $id('vps-port-auth')?.value.trim() || '5000';
  $id('cloud-registry').value = host ? `${host}:${port}` : '';
}

function setCloudAuthBadge(text, type) {
  const badge = $id('cloud-auth-badge');
  if (!badge) return;
  badge.textContent = text;
  badge.className   = 'cloud-auth-badge' + (type ? ` ${type}` : '');
}

// ─── Recolectar credenciales desde los campos del proveedor activo ──────────
function collectCloudCreds() {
  const p = state.selectedCloud;
  if (p === 'azure') {
    return {
      registry: $id('az-registry').value.trim(),
      username: $id('az-user').value.trim(),
      password: $id('az-password').value
    };
  }
  if (p === 'dockerhub') {
    const user = $id('dh-user').value.trim();
    return {
      registry: 'registry-1.docker.io',
      username: user,
      password: $id('dh-password').value
    };
  }
  if (p === 'huawei') {
    const region = $id('hw-region').value.trim();
    const ak     = $id('hw-ak').value.trim();
    const sk     = $id('hw-sk').value.trim();
    return {
      registry: `swr.${region}.myhuaweicloud.com`,
      username: `${region}@${ak}`,
      password: sk,
      hwAk: ak, hwSk: sk, hwRegion: region
    };
  }
  if (p === 'vps') {
    const host = $id('vps-host-auth').value.trim();
    const port = $id('vps-port-auth').value.trim() || '5000';
    return {
      registry: `${host}:${port}`,
      username: $id('vps-user-auth').value.trim() || '',
      password: $id('vps-pass-auth').value || ''
    };
  }
  // aws: se maneja aparte con awsEcrLogin
  return null;
}

// ─── CONECTAR al registry (con login + listar repos) ────────────────────────
async function connectCloudRegistry() {
  const p = state.selectedCloud;
  if (!p) { showToast('Selecciona un proveedor primero', 'info'); return; }

  const statusEl = $id('cloud-auth-status');
  statusEl.textContent = '⏳ Conectando…';
  setCloudAuthBadge('Conectando…', '');

  let creds;

  // Caso especial AWS: obtener token ECR vía aws CLI
  if (p === 'aws') {
    const accountId = $id('aws-account-id').value.trim();
    const region    = $id('aws-region-id').value.trim();
    const keyId     = $id('aws-key-id').value.trim();
    const secret    = $id('aws-secret').value.trim();

    if (!accountId || !region) {
      statusEl.textContent = '✗ Ingresa Account ID y Región';
      setCloudAuthBadge('Error', 'error');
      return;
    }

    // Si hay credenciales de clave, inyectarlas como variables de entorno
    // (aws CLI las leerá automáticamente)
    statusEl.textContent = '⏳ Obteniendo token ECR…';
    const ecrRes = await api.cloudAwsEcrLogin({ region, accountId });
    if (!ecrRes.ok) {
      statusEl.textContent = `✗ ${ecrRes.error}`;
      setCloudAuthBadge('Error', 'error');
      showToast('Error ECR: ' + ecrRes.error, 'error');
      return;
    }
    creds = { registry: ecrRes.registry, username: ecrRes.username, password: ecrRes.password };
    $id('cloud-registry').value = ecrRes.registry;
    $id('cloud-region').value   = region;
    $id('cloud-account').value  = accountId;
  } else {
    creds = collectCloudCreds();
    if (!creds || !creds.registry) {
      statusEl.textContent = '✗ Completa los campos de credenciales';
      setCloudAuthBadge('Error', 'error');
      return;
    }
    $id('cloud-registry').value = creds.registry;
    if (creds.hwRegion) $id('cloud-region').value = creds.hwRegion;
  }

  // docker login
  statusEl.textContent = '⏳ Haciendo docker login…';
  const loginRes = await api.cloudDockerLogin({
    registry: creds.registry,
    username: creds.username,
    password: creds.password
  });

  if (!loginRes.ok) {
    statusEl.textContent = `✗ Login fallido: ${loginRes.error || loginRes.message}`;
    setCloudAuthBadge('Sin conexión', 'error');
    showToast('Login fallido', 'error');
    return;
  }

  // Guardar creds en state
  state.cloudRegistryCreds = creds;
  setCloudAuthBadge(`✓ ${creds.registry}`, 'connected');
  statusEl.textContent = `✓ Login exitoso`;
  const discBtn = $id('cloud-disconnect-btn');
  if (discBtn) discBtn.style.display = '';
  showToast(`✓ Conectado a ${creds.registry}`, 'success');

  // Cargar explorador
  await refreshCloudExplorer();
}

function disconnectCloudRegistry() {
  state.cloudRegistryCreds = null;
  const explorer = $id('cloud-explorer');
  if (explorer) explorer.style.display = 'none';
  setCloudAuthBadge('', '');
  $id('cloud-auth-status').textContent = '';
  const discBtn = $id('cloud-disconnect-btn');
  if (discBtn) discBtn.style.display = 'none';
  showToast('Desconectado del registry', 'info');
}

// ─── EXPLORADOR ──────────────────────────────────────────────────────────────
async function refreshCloudExplorer() {
  const creds = state.cloudRegistryCreds;
  if (!creds) { showToast('Conecta primero al registry', 'info'); return; }

  const explorer = $id('cloud-explorer');
  if (explorer) explorer.style.display = '';

  const tree = $id('cloud-explorer-tree');
  tree.innerHTML = `<div class="cloud-explorer-empty"><div class="spinner" style="width:14px;height:14px;margin:0 auto 6px"></div>Cargando repositorios…</div>`;

  const res = await api.cloudListRepos({
    registry: creds.registry,
    username: creds.username,
    password: creds.password
  });

  if (!res.ok) {
    tree.innerHTML = `<div class="cloud-explorer-empty" style="color:var(--red)">✗ ${escHtml(res.error)}</div>`;
    return;
  }

  const repos = res.repositories || [];
  const countEl = $id('cloud-explorer-count');
  if (countEl) countEl.textContent = `${repos.length} repositorio(s)`;

  if (repos.length === 0) {
    tree.innerHTML = `<div class="cloud-explorer-empty">Registry vacío — aún no hay imágenes subidas</div>`;
    return;
  }

  renderCloudExplorer(repos);
}

function renderCloudExplorer(repos) {
  const tree = $id('cloud-explorer-tree');
  tree.innerHTML = '';

  repos.forEach(repo => {
    const row = document.createElement('div');
    row.className = 'cloud-repo-row';
    row.innerHTML = `
      <span class="cloud-repo-icon">▶</span>
      <span class="cloud-repo-name">${escHtml(repo)}</span>
      <span class="cloud-repo-count"></span>
    `;

    let tagsLoaded = false;
    let tagsEl = null;

    row.onclick = async () => {
      const icon = row.querySelector('.cloud-repo-icon');
      if (tagsEl && tagsEl.style.display !== 'none') {
        tagsEl.style.display = 'none';
        icon.classList.remove('open');
        return;
      }
      icon.classList.add('open');

      if (!tagsLoaded) {
        if (!tagsEl) {
          tagsEl = document.createElement('div');
          tagsEl.className = 'cloud-tags-list';
          tagsEl.innerHTML = `<div class="cloud-tag-row" style="color:var(--text-3)">⏳ Cargando tags…</div>`;
          row.insertAdjacentElement('afterend', tagsEl);
        }
        const creds = state.cloudRegistryCreds;
        const res = await api.cloudListTags({
          registry: creds.registry, username: creds.username,
          password: creds.password, repo
        });
        tagsLoaded = true;
        const count = row.querySelector('.cloud-repo-count');
        if (res.ok && res.tags?.length) {
          count.textContent = `${res.tags.length} tags`;
          tagsEl.innerHTML = '';
          res.tags.forEach(tag => {
            const tr = document.createElement('div');
            tr.className = 'cloud-tag-row';
            tr.innerHTML = `
              <span class="cloud-tag-name">📦 ${escHtml(repo)}:<b>${escHtml(tag)}</b></span>
              <span class="cloud-tag-add">+ añadir a cola</span>
            `;
            tr.onclick = (e) => { e.stopPropagation(); addCloudImageFromExplorer(repo, tag); };
            tagsEl.appendChild(tr);
          });
        } else if (res.ok) {
          count.textContent = '0 tags';
          tagsEl.innerHTML = `<div class="cloud-tag-row" style="color:var(--text-3)">Sin tags aún</div>`;
        } else {
          tagsEl.innerHTML = `<div class="cloud-tag-row" style="color:var(--red)">✗ ${escHtml(res.error || 'Error')}</div>`;
        }
      } else {
        tagsEl.style.display = '';
      }
    };
    tree.appendChild(row);
  });
}

function addCloudImageFromExplorer(repo, tag) {
  const fullName = `${state.cloudRegistryCreds.registry}/${repo}:${tag}`;
  showToast(`📋 ${fullName} copiado al portapapeles`, 'info', 2500);
  navigator.clipboard.writeText(fullName).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════
// CLOUD — Generar y ejecutar comandos
// ══════════════════════════════════════════════════════════════════
async function generateCloudCommands() {
  const provider = state.selectedCloud;
  if (!provider) { showToast('Selecciona un proveedor cloud primero', 'warn'); return; }
  if (!state.cloudImages.length) { showToast('Agrega al menos una imagen a la cola', 'warn'); return; }

  const creds = collectCloudCreds();

  let commands = [];
  for (const img of state.cloudImages) {
    const res = await api.getCloudCommands({
      provider,
      image:      img.localName,
      registry:   creds.registry   || $id('cloud-registry')?.value || '',
      region:     creds.region     || '',
      accountId:  creds.accountId  || '',
      repo:       img.destTag      || img.localName,
      username:   creds.username   || '',
      password:   creds.password   || '',
      hwAk:       creds.hwAk       || '',
      hwSk:       creds.hwSk       || '',
    });
    if (res.ok && res.commands) {
      commands = commands.concat(res.commands.map(c => ({ cmd: c, image: img.localName })));
    }
  }

  if (!commands.length) { showToast('No se generaron comandos', 'warn'); return; }

  const outputEl = $id('cloud-output');
  if (outputEl) {
    outputEl.innerHTML = commands.map(c =>
      `<div class="cloud-cmd-line">${escHtml(c.cmd)}</div>`
    ).join('');
    outputEl.style.display = 'block';
  }

  showToast(`${commands.length} comandos generados`, 'ok');
}

// ══════════════════════════════════════════════════════════════════
// WSL — Estado y helpers
// ══════════════════════════════════════════════════════════════════
const wslState = {
  distros:         [],
  selected:        null,   // nombre de la distro seleccionada
  selectedIsRemote:false,  // true when selected distro is on remote machine
  sshInfo:         null,   // resultado de wslSshStatus
  transferFiles:   [],     // lista de archivos a transferir
  activeSubpanel:  null,   // 'ssh' | 'mounts' | 'transfer' | null
};

function $wsl(id) { return document.getElementById(id); }

function wslLog(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString();
  // push to persistent buffer for the unified Logs tab
  wslLogBuffer.push({ ts, msg, level });
  if (wslLogBuffer.length > 2000) wslLogBuffer.shift();
  // if WSL log is currently shown in Logs tab, refresh it
  if (currentLogSource === 'wsl' && document.getElementById('log-body')) {
    renderWslLog();
  }
  const el = $wsl('wsl-log');
  if (!el) return;
  const cls = { ok:'wsl-log-ok', err:'wsl-log-err', cmd:'wsl-log-cmd', info:'wsl-log-info' }[level] || 'wsl-log-info';
  el.innerHTML += `<span class="${cls}">[${ts}] ${escHtml(msg)}</span>\n`;
  el.scrollTop = el.scrollHeight;
}

function wslLogMini(logId, msg) {
  const el = $wsl(logId);
  if (!el) return;
  el.textContent += msg;
  el.scrollTop = el.scrollHeight;
}

function wslClearLog() {
  const el = $wsl('wsl-log');
  if (el) el.innerHTML = '';
}

function wslSetSelected(name, isRemote) {
  wslState.selected        = name;
  wslState.selectedIsRemote = !!isRemote;
  const lbl = $wsl('wsl-sel-label');
  if (lbl) {
    if (name) lbl.innerHTML = (isRemote ? '<span class="wsl-remote-badge-sm">🌐</span> ' : '') + escHtml(name);
    else lbl.textContent = 'Selecciona una distribución';
  }

  // Resaltar fila
  document.querySelectorAll('#wsl-tbody tr').forEach(tr => {
    tr.classList.toggle('selected', tr.dataset.name === name);
  });

  // Actualizar nombre en sub-paneles (only for local)
  if (!isRemote) {
    ['wsl-ssh-distro-name','wsl-mounts-distro-name','wsl-transfer-distro-name'].forEach(id => {
      const el = $wsl(id);
      if (el) el.textContent = name || '';
    });
  }
}

// ── Listar / refrescar ────────────────────────────────────────────
async function refreshWsl() {
  const tbody = $wsl('wsl-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="wsl-empty">Cargando…</td></tr>';

  const res = await api.wslList().catch(() => ({ ok: false, error: 'Error de conexión', distros: [] }));

  const badge = document.getElementById('badge-wsl');
  if (!res.ok) {
    tbody.innerHTML = `<tr><td colspan="6" class="wsl-empty" style="color:var(--text-3)">${escHtml(res.error || 'WSL no disponible (solo Windows)')}</td></tr>`;
    if (badge) badge.textContent = '0';
    wslLog(res.error || 'WSL no disponible', 'err');
    return;
  }

  wslState.distros = res.distros;
  if (badge) badge.textContent = res.distros.length;
  const countEl = $wsl('wsl-count');
  if (countEl) countEl.textContent = `${res.distros.length} distro(s)`;

  if (!res.distros.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="wsl-empty">No hay distribuciones WSL instaladas</td></tr>';
    return;
  }

  tbody.innerHTML = res.distros.map(d => {
    const stateClass = d.state === 'Running' ? 'wsl-state-running' : 'wsl-state-stopped';
    const defMark    = d.isDefault ? '★' : '';
    const ipCell     = d.state === 'Running'
      ? `<span id="wsl-ip-${CSS.escape(d.name)}" class="wsl-ip-chip">…</span>`
      : '<span class="wsl-port-count">—</span>';
    return `<tr data-name="${escHtml(d.name)}" onclick="wslSetSelected('${escHtml(d.name)}')" oncontextmenu="wslCtxMenu(event,'${escHtml(d.name)}')">
      <td><span class="wsl-row-check"></span></td>
      <td><strong>${escHtml(d.name)}</strong> <span style="color:var(--yellow)">${defMark}</span></td>
      <td><span class="wsl-state-badge ${stateClass}">${escHtml(d.state)}</span></td>
      <td style="text-align:center">WSL${escHtml(d.version)}</td>
      <td style="text-align:center">${d.isDefault ? '★' : ''}</td>
      <td>${ipCell}</td>
      <td>${escHtml(d.size)}</td>
      <td class="wsl-col-path" title="${escHtml(d.path)}">${escHtml(d.path)}</td>
    </tr>`;
  }).join('');

  // Cargar IPs de distros en ejecución async
  res.distros.filter(d => d.state === 'Running').forEach(d => loadWslIp(d.name));

  // Append remote distros if connected
  if (remoteState.connected && remoteState.distros.length) {
    _wslAppendRemoteRows(remoteState.distros);
  }

  // Restaurar selección
  if (wslState.selected) wslSetSelected(wslState.selected, wslState.selectedIsRemote);
  wslLog(`${res.distros.length} distro(s) cargadas`, 'ok');
}

// ── Acciones globales ─────────────────────────────────────────────
async function wslActionGlobal(action) {
  const labels = { shutdown: 'Apagar TODAS las distros', update: 'Actualizar motor WSL' };
  if (!confirm(`¿${labels[action] || action}?`)) return;
  wslLog(`wsl --${action}…`, 'cmd');
  const res = await api.wslAction(action, null).catch(() => ({ ok: false }));
  wslLog(res.output || (res.ok ? 'OK' : 'Error'), res.ok ? 'ok' : 'err');
  if (action === 'shutdown') setTimeout(refreshWsl, 1500);
}

async function wslShowStatus() {
  const res = await api.wslAction('status', null).catch(() => ({ ok: false, output: '' }));
  showInfoModal('wsl --status', res.output || 'Sin salida');
}

// ── Acciones sobre distro seleccionada ───────────────────────────
function wslRequireSelected() {
  if (!wslState.selected) { showToast('Selecciona una distribución primero', 'warn'); return false; }
  return true;
}

async function wslActionSel(action) {
  if (!wslRequireSelected()) return;
  const d = wslState.selected;
  if (wslState.selectedIsRemote) {
    if (!confirm(`¿${action} '${d}' en ${remoteState.host}?`)) return;
    await wslRemoteAction(d, action);
    return;
  }
  const labels = { terminate: `Detener '${d}'`, start: `Iniciar '${d}'`, restart: `Reiniciar '${d}'`, setDefault: `Marcar '${d}' como default`, unregister: `Eliminar '${d}'` };
  if (!confirm(`¿${labels[action] || action}?`)) return;
  wslLog(`wsl --${action} ${d}…`, 'cmd');
  const res = await api.wslAction(action, d).catch(() => ({ ok: false }));
  wslLog(res.output || (res.ok ? 'OK' : 'Error'), res.ok ? 'ok' : 'err');
  setTimeout(refreshWsl, 1200);
}

async function wslOpenTerminal() {
  if (!wslRequireSelected()) return;
  if (wslState.selectedIsRemote) {
    wslRemoteTerminal(wslState.selected);
    return;
  }
  const res = await api.wslOpenTerminal(wslState.selected).catch(() => ({ ok: false }));
  if (res.ok) wslLog(`Terminal abierta para '${wslState.selected}'`, 'ok');
  else wslLog(res.error || 'Error abriendo terminal', 'err');
  setTimeout(refreshWsl, 2000);
}

async function wslOpenExplorer() {
  if (!wslRequireSelected()) return;
  const res = await api.wslOpenExplorer(wslState.selected).catch(() => ({ ok: false }));
  wslLog(res.ok ? `Explorer abierto para '${wslState.selected}'` : (res.error || 'Error'), res.ok ? 'ok' : 'err');
}

async function wslToggleVersion() {
  if (!wslRequireSelected()) return;
  const d = wslState.distros.find(x => x.name === wslState.selected);
  if (!d) return;
  const cur = d.version; const tgt = cur === '2' ? '1' : '2';
  if (!confirm(`¿Convertir '${d.name}' de WSL${cur} a WSL${tgt}? Puede tardar varios minutos.`)) return;
  wslLog(`Convirtiendo '${d.name}' a WSL${tgt}…`, 'cmd');
  showToast('Conversión en curso… puede tardar varios minutos', 'info', 5000);
  const res = await api.wslSetVersion(d.name, tgt).catch(() => ({ ok: false }));
  wslLog(res.output || (res.ok ? 'OK' : 'Error'), res.ok ? 'ok' : 'err');
  setTimeout(refreshWsl, 1200);
}

// ── WSL Resources Monitor ─────────────────────────────────────────────────
const _wslRes = { distro: null, timer: null, auto: true };

async function wslShowResources() {
  if (!wslRequireSelected()) return;
  if (wslState.selectedIsRemote) {
    wslRemoteResources(wslState.selected);
    return;
  }
  _wslRes.distro = wslState.selected;
  const modal = document.getElementById('wsl-res-modal');
  const nameEl = document.getElementById('wsl-res-distro-name');
  if (nameEl) nameEl.textContent = _wslRes.distro;
  if (modal) modal.style.display = 'flex';
  _wslRes.auto = true;
  await wslResRefresh();
  _wslRes.timer = setInterval(wslResRefresh, 5000);
}

function wslResClose() {
  clearInterval(_wslRes.timer);
  _wslRes.timer = null;
  _wslRes.remote = false;
  _wslRes.remDist = null;
  const modal = document.getElementById('wsl-res-modal');
  if (modal) modal.style.display = 'none';
  // Reset badge
  const badge = document.getElementById('wsl-res-refresh-badge');
  if (badge) { badge.textContent = '↻ Auto'; badge.style.background = ''; }
}

function wslResToggleAuto() {
  const btn = document.querySelector('#wsl-res-modal .wsl-res-footer button:last-child');
  if (_wslRes.timer) {
    clearInterval(_wslRes.timer); _wslRes.timer = null; _wslRes.auto = false;
    if (btn) btn.textContent = '▶ Reanudar';
    document.getElementById('wsl-res-refresh-badge')?.style && (document.getElementById('wsl-res-refresh-badge').style.opacity = '0.4');
  } else {
    _wslRes.auto = true;
    _wslRes.timer = setInterval(wslResRefresh, 5000);
    if (btn) btn.textContent = '⏸ Pausar';
    document.getElementById('wsl-res-refresh-badge')?.style && (document.getElementById('wsl-res-refresh-badge').style.opacity = '1');
    wslResRefresh();
  }
}

async function wslResRefresh() {
  if (_wslRes.remote && _wslRes.remDist) {
    await _wslFetchRemoteResources(_wslRes.remDist);
    return;
  }
  if (!_wslRes.distro) return;
  const res = await api.wslGetResources(_wslRes.distro).catch(() => ({ ok: false }));
  if (!res.ok) return;
  _wslResRenderCPU(res.ps);
  _wslResRenderMem(res.mem);
  _wslResRenderDisk(res.df);
  _wslResRenderPorts(res.ports);
  const lu = document.getElementById('wsl-res-last-update');
  if (lu) lu.textContent = 'Actualizado: ' + new Date().toLocaleTimeString();
}

function _wslResBar(id, pct, warn=70, danger=90) {
  const el = document.getElementById(id);
  if (!el) return;
  const p = Math.min(100, Math.max(0, pct));
  el.style.width = p + '%';
  el.style.background = p >= danger ? 'var(--red,#ef4444)' : p >= warn ? '#f59e0b' : 'var(--green,#22c55e)';
}

function _wslResRenderCPU(psRaw) {
  if (!psRaw) return;
  const lines = psRaw.trim().split('\n').filter(Boolean);
  // header: PID %CPU %MEM COMMAND
  let totalCpu = 0, rows = '';
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].trim().split(/\s+/);
    if (p.length < 4) continue;
    const cpu = parseFloat(p[1]) || 0;
    totalCpu += cpu;
    if (i <= 6) {
      const bar = Math.min(100, cpu * 2); // scale: 50% cpu = full bar
      rows += `<div class="wsl-res-proc-row">
        <span class="wsl-res-proc-name">${escHtml(p[3]||'?')}</span>
        <div class="wsl-res-proc-bar-wrap"><div class="wsl-res-proc-bar" style="width:${bar}%;background:${cpu>20?'var(--red,#ef4444)':cpu>5?'#f59e0b':'var(--blue,#3b82f6)'}"></div></div>
        <span class="wsl-res-proc-pct">${cpu.toFixed(1)}%</span>
      </div>`;
    }
  }
  const cpuPct = Math.min(100, totalCpu);
  const lbl = document.getElementById('wsl-res-cpu-lbl');
  if (lbl) lbl.textContent = 'Total visible';
  _wslResBar('wsl-res-cpu-bar', cpuPct);
  const pctEl = document.getElementById('wsl-res-cpu-pct');
  if (pctEl) pctEl.textContent = cpuPct.toFixed(1) + '%';
  const procsEl = document.getElementById('wsl-res-procs');
  if (procsEl) procsEl.innerHTML = rows;
}

function _wslResRenderMem(memRaw) {
  if (!memRaw) return;
  // free -h output: Mem: total used free shared buff/cache available
  let ramPct = 0, swapPct = 0, detail = '';
  const lines = memRaw.trim().split('\n');
  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'Mem:' && p.length >= 7) {
      detail = `Total: ${p[1]}  Usado: ${p[2]}  Libre: ${p[3]}  Disponible: ${p[6]||p[3]}`;
      // Parse numeric values (strip unit suffixes)
      const used = parseFloat(p[2]), total = parseFloat(p[1]);
      if (total > 0) ramPct = Math.round((used / total) * 100);
    }
    if (p[0] === 'Swap:' && p.length >= 4) {
      const used = parseFloat(p[2]), total = parseFloat(p[1]);
      if (total > 0) swapPct = Math.round((used / total) * 100);
      else swapPct = 0;
    }
  }
  _wslResBar('wsl-res-ram-bar', ramPct);
  _wslResBar('wsl-res-swap-bar', swapPct, 50, 80);
  const rp = document.getElementById('wsl-res-ram-pct');
  if (rp) rp.textContent = ramPct + '%';
  const sp = document.getElementById('wsl-res-swap-pct');
  if (sp) sp.textContent = swapPct + '%';
  const dt = document.getElementById('wsl-res-mem-detail');
  if (dt) dt.textContent = detail;
}

function _wslResRenderDisk(dfRaw) {
  if (!dfRaw) return;
  const diskEl = document.getElementById('wsl-res-disk');
  if (!diskEl) return;
  const lines = dfRaw.trim().split('\n').filter(Boolean);
  let html = '';
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].trim().split(/\s+/);
    // df -hT: Filesystem Type Size Used Avail Use% Mounted
    if (p.length < 7) continue;
    const fstype = p[1] || '';
    if (['tmpfs','devtmpfs','overlay','none','udev'].includes(fstype)) continue;
    const pctStr = p[5] || p[4] || '0%';
    const pct = parseInt(pctStr, 10) || 0;
    const mount = p[6] || p[5] || '';
    const color = pct >= 90 ? 'var(--red,#ef4444)' : pct >= 70 ? '#f59e0b' : 'var(--green,#22c55e)';
    html += `<div class="wsl-res-row" style="margin-bottom:6px">
      <span class="wsl-res-lbl" title="${escHtml(p[0])}">${escHtml(mount)}</span>
      <div class="wsl-res-bar-wrap"><div class="wsl-res-bar" style="width:${pct}%;background:${color}"></div></div>
      <span class="wsl-res-pct">${pctStr} (${p[2]||'?'} total)</span>
    </div>`;
  }
  diskEl.innerHTML = html || '<span style="color:var(--text-2)">Sin datos de disco</span>';
}

function _wslResRenderPorts(portsRaw) {
  const sec = document.getElementById('wsl-res-ports-section');
  const pre = document.getElementById('wsl-res-ports-pre');
  if (!sec || !pre) return;
  const txt = portsRaw?.trim();
  if (txt && txt.length > 5) {
    sec.style.display = '';
    pre.textContent = txt;
  } else {
    sec.style.display = 'none';
  }
}

async function wslUpgradePackages() {
  if (!wslRequireSelected()) return;
  const d  = wslState.selected;
  const nl = d.toLowerCase();
  let key  = 'pkg:update:deb';
  if (['alma','rocky','fedora','oracle','centos'].some(k => nl.includes(k))) key = 'pkg:update:rpm';
  else if (nl.includes('arch')) key = 'pkg:update:pac';
  else if (nl.includes('suse')) key = 'pkg:update:zpp';
  if (!confirm(`¿Actualizar paquetes en '${d}'?\nEl proceso se mostrará en el Log WSL.`)) return;
  wslLog(`Actualizando paquetes en '${d}'…`, 'cmd');
  const sid = 'pkg-upd-' + Date.now();
  api.wslStreamPreset(d, key, sid);
  wslState._pkgStreamId = sid;
}

async function wslExport() {
  if (!wslRequireSelected()) return;
  const distro = wslState.selected;

  // Step 1: show save-file dialog first so user knows where it goes
  showToast('📁 Elige dónde guardar el archivo de exportación…', 'info', 4000);
  const pick = await api.wslExportPick(distro).catch(() => ({ ok: false }));
  if (!pick || pick.cancelled) { showToast('Exportación cancelada', 'info', 2000); return; }
  if (!pick.ok) { showToast('Error seleccionando ruta', 'error'); return; }

  // Step 2: run export with streaming progress in the WSL log
  const sid = 'export-' + Date.now();
  wslState._exportStreamId  = sid;
  wslState._exportDistro    = distro;
  wslState._exportFilePath  = pick.filePath;

  wslLog(`Exportando '${distro}' → ${pick.filePath}`, 'cmd');
  showToast('Exportando… puede tardar varios minutos', 'info', 8000);

  const res = await api.wslExportRun(distro, pick.filePath, sid).catch(() => ({ ok: false }));
  if (!res.ok) {
    showToast('✗ Error iniciando exportación', 'error');
    wslLog('Error: ' + (res.error || 'desconocido'), 'err');
  }
  // Result is handled in onStreamEnd → wslHandleExportStreamEnd
}

function wslHandleExportStreamEnd(streamId, code, filePath) {
  if (streamId !== wslState._exportStreamId) return false;
  wslState._exportStreamId = null;
  if (code === 0 && filePath) {
    wslLog('Exportación completada: ' + filePath, 'ok');
    showToast('✓ Exportación completada', 'ok', 3000);
    wslExportResultShow(wslState._exportDistro || '', filePath);
  } else {
    wslLog('Error en la exportación (código ' + code + ')', 'err');
    showToast('✗ Exportación fallida — revisa el log WSL', 'error', 5000);
  }
  return true;
}

// ── Export result modal ────────────────────────────────────────────────────
let _exportResultPath = '';
function wslExportResultShow(distro, filePath) {
  _exportResultPath = filePath || '';
  const modal = document.getElementById('wsl-export-result-modal');
  if (!modal) return;
  document.getElementById('wsl-er-distro').textContent = distro;
  document.getElementById('wsl-er-path').textContent   = filePath || '—';
  document.getElementById('wsl-er-size').textContent   = 'calculando…';
  modal.style.display = 'flex';
  // Get file size via IPC
  if (filePath) {
    api.wslGetFileSize(filePath).then(r => {
      const sizeEl = document.getElementById('wsl-er-size');
      if (sizeEl) sizeEl.textContent = r?.size || '—';
    }).catch(() => {
      const sizeEl = document.getElementById('wsl-er-size');
      if (sizeEl) sizeEl.textContent = '—';
    });
  }
}
function wslExportResultClose() {
  document.getElementById('wsl-export-result-modal').style.display = 'none';
}
function wslErOpenFolder() {
  if (_exportResultPath) api.wslOpenFolder(_exportResultPath);
}
function wslErCopyPath() {
  if (!_exportResultPath) return;
  navigator.clipboard.writeText(_exportResultPath)
    .then(() => showToast('Ruta copiada al portapapeles', 'ok', 2000))
    .catch(() => showToast('No se pudo copiar', 'warn'));
}

// ── Network / path export ─────────────────────────────────────────────────
function wslNetExportOpen() {
  if (!wslRequireSelected()) return;
  const d = document.getElementById('wsl-ne-distro');
  if (d) d.value = wslState.selected;
  const r = document.getElementById('wsl-ne-result');
  if (r) r.style.display = 'none';
  const btn = document.getElementById('wsl-ne-btn');
  if (btn) { btn.disabled = false; btn.textContent = '🚀 Exportar'; }
  document.getElementById('wsl-netexport-modal').style.display = 'flex';
}

function wslNetExportClose() {
  document.getElementById('wsl-netexport-modal').style.display = 'none';
}

async function wslDoNetExport() {
  const distro  = document.getElementById('wsl-ne-distro')?.value?.trim();
  const destPath = document.getElementById('wsl-ne-dest')?.value?.trim();
  if (!distro || !destPath) { showToast('Completa todos los campos', 'warn'); return; }
  const btn = document.getElementById('wsl-ne-btn');
  const resultEl = document.getElementById('wsl-ne-result');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Exportando…'; }
  if (resultEl) { resultEl.style.display = 'none'; }
  showToast('Exportando a red… puede tardar varios minutos', 'info', 8000);
  const res = await api.wslExportToNetwork(distro, destPath).catch(() => ({ ok: false, error: 'Error de conexión' }));
  if (btn) { btn.disabled = false; btn.textContent = '🚀 Exportar'; }
  if (resultEl) {
    resultEl.style.display = '';
    if (res.ok) {
      resultEl.style.background = 'rgba(34,197,94,.12)';
      resultEl.style.color = 'var(--green,#22c55e)';
      resultEl.innerHTML = `✓ Exportado correctamente<br><code style="font-size:11px">${escHtml(res.filePath||'')}</code>`;
      wslLog(`Exportado por red: ${res.filePath}`, 'ok');
      showToast('✓ Exportación en red completada', 'ok', 5000);
    } else {
      resultEl.style.background = 'rgba(239,68,68,.12)';
      resultEl.style.color = 'var(--red,#ef4444)';
      resultEl.textContent = '✗ Error: ' + (res.error || res.output || 'desconocido');
      wslLog('Error exportación red: ' + (res.error || ''), 'err');
    }
  }
}

async function wslImportFlow() {
  // Primero seleccionar archivo
  const pick = await api.wslImportDialog().catch(() => ({ ok: false }));
  if (!pick.ok || pick.cancelled) return;
  $wsl('wsl-import-src').value  = pick.filePath;
  $wsl('wsl-import-name').value = 'MiDistroImportada';
  $wsl('wsl-import-dir').value  = '';
  $wsl('wsl-import-modal').style.display = 'flex';
}

function wslCloseImportModal() {
  $wsl('wsl-import-modal').style.display = 'none';
}

async function wslPickImportSrc() {
  const pick = await api.wslImportDialog().catch(() => ({ ok: false }));
  if (pick.ok) $wsl('wsl-import-src').value = pick.filePath;
}

async function wslPickImportDir() {
  const res = await api.openFolder().catch(() => null);
  if (res) $wsl('wsl-import-dir').value = res;
}

async function wslDoImport() {
  const name = $wsl('wsl-import-name').value.trim();
  const dir  = $wsl('wsl-import-dir').value.trim();
  const src  = $wsl('wsl-import-src').value.trim();
  if (!name || !dir || !src) { showToast('Completa todos los campos', 'warn'); return; }
  wslCloseImportModal();
  wslLog(`Importando '${src}' como '${name}'…`, 'cmd');
  showToast('Importando… puede tardar varios minutos', 'info', 5000);
  const res = await api.wslImport(name, dir, src).catch(() => ({ ok: false }));
  wslLog(res.ok ? `Importado: '${name}'` : (res.output || 'Error'), res.ok ? 'ok' : 'err');
  if (res.ok) { showToast(`'${name}' importada ✓`, 'ok'); setTimeout(refreshWsl, 1200); }
}

async function wslDelete() {
  if (!wslRequireSelected()) return;
  const d = wslState.selected;
  if (!confirm(`⚠ ELIMINACIÓN PERMANENTE\n\nVas a eliminar la distro '${d}'.\nSe perderán TODOS los archivos, incluyendo la imagen VHDX.\n\n¿Continuar?`)) return;
  // Segunda confirmación — requiere escribir el nombre
  const typed = prompt(`Escribe exactamente el nombre de la distro para confirmar la eliminación:\n\n${d}`);
  if (typed !== d) { showToast('Eliminación cancelada — el nombre no coincide', 'warn'); return; }
  wslLog(`wsl --unregister ${d}…`, 'cmd');
  const res = await api.wslAction('unregister', d).catch(() => ({ ok: false, output: 'Error de comunicación' }));
  const out = (res.output || '').trim();
  if (res.ok) {
    wslLog(`'${d}' eliminada correctamente.`, 'ok');
    wslState.selected = null;
    setTimeout(refreshWsl, 1000);
  } else {
    wslLog(`Error al eliminar '${d}': ${out || 'wsl --unregister falló (código ≠ 0)'}`, 'err');
    showToast('Error al eliminar la distro — revisa el log WSL', 'error');
  }
}

// ── Sub-paneles ───────────────────────────────────────────────────
function wslShowPanel(name) {
  if (!wslRequireSelected()) return;
  wslState.activeSubpanel = name;
  const wrap = $wsl('wsl-subpanel-wrap');
  if (wrap) wrap.style.display = 'block';
  ['ssh','mounts','transfer'].forEach(p => {
    const el = $wsl(`wsl-panel-${p}`);
    if (el) el.style.display = p === name ? 'block' : 'none';
  });
  if (name === 'ssh')      wslRefreshSsh();
  if (name === 'mounts')   wslRefreshMounts();
  if (name === 'transfer') wslInitTransfer();
}

function wslHidePanel() {
  const wrap = $wsl('wsl-subpanel-wrap');
  if (wrap) wrap.style.display = 'none';
  wslState.activeSubpanel = null;
}
function wslClosePanel() { wslHidePanel(); }

// ── Auto-install missing tools ────────────────────────────────────────────────
// Detect distro family from the name
function _distroFamily(name) {
  const n = (name || '').toLowerCase();
  if (['alma','rocky','fedora','oracle','centos','rhel'].some(k => n.includes(k))) return 'rpm';
  if (n.includes('arch') || n.includes('manjaro')) return 'pac';
  if (n.includes('suse') || n.includes('opensuse')) return 'zpp';
  return 'deb'; // Ubuntu, Debian, Kali, Mint, Pop...
}

let _pendingToolInstall = null; // { preset, distro, streamId }

// Show an inline notification offering to install a missing tool
function wslOfferInstall(toolKey, toolLabel, gatewayDistro) {
  const family  = _distroFamily(gatewayDistro);
  const preset  = `tool:${toolKey}:${family}`;
  const msgEl   = document.getElementById('rem-tool-msg');
  const notify  = document.getElementById('rem-tool-notify');
  const logWrap = document.getElementById('rem-tool-log-wrap');
  if (msgEl) msgEl.textContent = `"${toolLabel}" no está instalado en ${gatewayDistro}. ¿Instalar ahora?`;
  if (notify) notify.style.display = 'flex';
  if (logWrap) logWrap.style.display = 'none';
  _pendingToolInstall = { preset, distro: gatewayDistro };
}

async function wslInstallMissingTool() {
  if (!_pendingToolInstall) return;
  const { preset, distro } = _pendingToolInstall;
  const notify  = document.getElementById('rem-tool-notify');
  const logWrap = document.getElementById('rem-tool-log-wrap');
  const logEl   = document.getElementById('rem-tool-log');
  if (notify) notify.style.display = 'none';
  if (logWrap) { logWrap.style.display = 'block'; }
  if (logEl) logEl.textContent = '';
  showToast('Instalando…', 'info', 3000);
  const sid = 'tool-install-' + Date.now();
  // Wire stream to the install log
  wslState._toolInstallStreamId = sid;
  api.wslStreamPreset(distro, preset, sid);
}

// Handle tool install stream output
function wslHandleToolInstallStream(streamId, data) {
  if (streamId !== wslState._toolInstallStreamId) return false;
  const logEl = document.getElementById('rem-tool-log');
  if (logEl) { logEl.textContent += data; logEl.scrollTop = logEl.scrollHeight; }
  return true;
}

// Check if sshpass is available in a distro, offer install if not
async function wslCheckAndOfferSshpass(gatewayDistro) {
  if (!gatewayDistro) return;
  // Quick check via wslRun (non-streaming)
  try {
    const r = await api.wslStreamPreset(gatewayDistro, 'tool:check:sshpass', Date.now().toString()).catch(() => null);
  } catch {}
  // We check indirectly: if connection failed with NEEDS_KEY_AUTH, offer install
  wslOfferInstall('sshpass', 'sshpass', gatewayDistro);
}

// ── Remote WSL Manager ───────────────────────────────────────────────────────
const remoteState = {
  connected:      false,
  host:           '',
  port:           22,
  user:           '',
  password:       '',
  gatewayDistro:  '',
  distros:        [],
};

function wslToggleRemoteRibbon() {
  const ribbon = document.getElementById('wsl-remote-ribbon');
  if (!ribbon) return;
  const visible = ribbon.style.display !== 'none';
  ribbon.style.display = visible ? 'none' : 'block';
  if (!visible) wslRemoteRibbonOpen();
}

function wslRemoteRibbonOpen() {
  // Populate the gateway select with running local distros
  const sel = document.getElementById('rem-gateway');
  if (sel) {
    sel.innerHTML = '';
    const running = (wslState.distros || []).filter(d => d.state === 'Running');
    const all     = wslState.distros || [];
    const list    = running.length ? running : all;
    list.forEach(d => {
      const o = document.createElement('option');
      o.value = d.name; o.textContent = d.name + (d.state === 'Running' ? ' ●' : '');
      sel.appendChild(o);
    });
    if (remoteState.gatewayDistro) sel.value = remoteState.gatewayDistro;
  }
}

function _remoteSetConnected(connected) {
  remoteState.connected = connected;
  const connBtn  = document.getElementById('rem-connect-btn');
  const discBtn  = document.getElementById('rem-disconnect-btn');
  const statusEl = document.getElementById('rem-status');
  if (connBtn) connBtn.style.display = connected ? 'none' : '';
  if (discBtn) discBtn.style.display = connected ? '' : 'none';
  if (statusEl) {
    statusEl.textContent = connected ? '● Conectado a ' + remoteState.host : '';
    statusEl.style.color = connected ? 'var(--green,#22c55e)' : 'var(--text-2)';
  }
  // Update the topbar remote toggle button to indicate connection state
  const ribbonBtn = document.getElementById('wsl-ribbon-toggle-btn');
  if (ribbonBtn) {
    ribbonBtn.textContent = connected ? `🌐 Remoto ● ${remoteState.host}` : '🌐 Remoto';
    ribbonBtn.classList.toggle('btn-primary', connected);
  }
}

async function wslRemoteConnect() {
  const host    = document.getElementById('rem-host')?.value?.trim();
  const port    = parseInt(document.getElementById('rem-port')?.value || '22', 10) || 22;
  const user    = document.getElementById('rem-user')?.value?.trim();
  const pass    = document.getElementById('rem-pass')?.value || '';
  const gateway = document.getElementById('rem-gateway')?.value;

  if (!host || !user) { showToast('Introduce host y usuario', 'warn'); return; }
  if (!gateway) { showToast('Selecciona una distro WSL local como gateway', 'warn'); return; }

  const statusEl = document.getElementById('rem-status');
  if (statusEl) { statusEl.textContent = '⏳ Conectando…'; statusEl.style.color = 'var(--text-2)'; }
  document.getElementById('rem-connect-btn').disabled = true;

  remoteState.host = host; remoteState.port = port;
  remoteState.user = user; remoteState.password = pass;
  remoteState.gatewayDistro = gateway;

  const res = await api.wslRemoteList({ host, port, user, password: pass, gatewayDistro: gateway })
    .catch(e => ({ ok: false, error: e.message }));

  document.getElementById('rem-connect-btn').disabled = false;

  if (!res.ok) {
    if (statusEl) { statusEl.textContent = '✗ ' + (res.error || 'Error de conexión'); statusEl.style.color = 'var(--red,#ef4444)'; }
    showToast('Error: ' + (res.error || 'No se pudo conectar'), 'error', 5000);
    // Offer to install sshpass if that's the issue
    if (res.error && res.error.includes('sshpass')) {
      wslOfferInstall('sshpass', 'sshpass', gateway);
    }
    return;
  }

  remoteState.distros = res.distros;
  _remoteSetConnected(true);
  // Append remote distros to main table
  _wslAppendRemoteRows(res.distros);
  showToast(`✓ Conectado a ${host} — ${res.distros.length} distro(s)`, 'ok', 4000);
}

function wslRemoteDisconnect() {
  _remoteSetConnected(false);
  remoteState.distros = [];
  remoteState.connected = false;
  // Remove remote rows from main table
  document.querySelectorAll('#wsl-tbody tr[data-remote="true"]').forEach(tr => tr.remove());
  // Clear selection if it was a remote distro
  if (wslState.selectedIsRemote) {
    wslState.selected = null;
    wslState.selectedIsRemote = false;
    const lbl = document.getElementById('wsl-sel-label');
    if (lbl) lbl.textContent = 'Selecciona una distribución';
  }
}

async function wslRemoteRefresh() {
  if (!remoteState.connected) return;
  const res = await api.wslRemoteList({
    host: remoteState.host, port: remoteState.port,
    user: remoteState.user, password: remoteState.password,
    gatewayDistro: remoteState.gatewayDistro,
  }).catch(() => ({ ok: false }));
  if (res.ok) {
    remoteState.distros = res.distros;
    // Remove old remote rows, re-append
    document.querySelectorAll('#wsl-tbody tr[data-remote="true"]').forEach(tr => tr.remove());
    _wslAppendRemoteRows(res.distros);
    showToast('Distros remotas actualizadas', 'ok', 2000);
  }
}

// Append remote distros as rows in the main #wsl-tbody table
function _wslAppendRemoteRows(distros) {
  const tbody = document.getElementById('wsl-tbody');
  if (!tbody) return;
  // Remove any existing remote rows first
  tbody.querySelectorAll('tr[data-remote="true"]').forEach(tr => tr.remove());
  if (!distros.length) return;

  const host = remoteState.host;
  distros.forEach(d => {
    const running = d.state === 'Running';
    const tr = document.createElement('tr');
    tr.dataset.name   = d.name;
    tr.dataset.remote = 'true';
    tr.className      = 'wsl-remote-row';
    tr.innerHTML = `
      <td><span class="wsl-row-check ${running ? 'wsl-row-check-active' : ''}"></span></td>
      <td><span class="wsl-remote-badge-sm" title="Distro remota en ${escHtml(host)}">🌐</span> <strong>${escHtml(d.name)}</strong>${d.isDefault ? ' <span style="color:var(--yellow)">★</span>' : ''}</td>
      <td><span class="wsl-state-badge ${running ? 'wsl-state-running' : 'wsl-state-stopped'}">${escHtml(d.state)}</span></td>
      <td style="text-align:center">WSL${escHtml(d.version||'?')}</td>
      <td style="text-align:center">${d.isDefault ? '★' : ''}</td>
      <td><span class="wsl-port-count" title="${escHtml(host)}">🌐</span></td>
      <td>—</td>
      <td class="wsl-col-path" title="${escHtml(host)}">${escHtml(host)}</td>`;
    tr.onclick = () => wslSetSelected(d.name, true);
    tr.oncontextmenu = (e) => wslRemoteCtxMenu(e, d.name);
    tbody.appendChild(tr);
  });
}

// Context menu for remote distro rows — reuse the local #wsl-ctx-menu
// Since wslActionSel now routes through remote when selectedIsRemote=true, it just works.
function wslRemoteCtxMenu(e, distroName) {
  e.preventDefault();
  e.stopPropagation();
  wslSetSelected(distroName, true);
  _ctxTarget = distroName;
  const menu = document.getElementById('wsl-ctx-menu');
  if (!menu) return;
  // Hide "Eliminar" for remote distros (no unregister across network)
  const delItem = menu.querySelector('[onclick*="wslCtxDelete"]');
  if (delItem) delItem.style.display = 'none';
  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth  - menu.offsetWidth  - 8);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

// Keep old name as alias for any remaining callers
function wslRemoteRenderDistros(distros) { _wslAppendRemoteRows(distros); }

async function wslRemoteAction(distro, action) {
  const res = await api.wslRemoteAction({
    host: remoteState.host, port: remoteState.port,
    user: remoteState.user, password: remoteState.password,
    gatewayDistro: remoteState.gatewayDistro,
    distro, action,
  }).catch(() => ({ ok: false }));
  showToast(res.ok ? `✓ ${action} completado` : ('✗ ' + (res.output || 'Error')), res.ok ? 'ok' : 'error', 3000);
  setTimeout(wslRemoteRefresh, 1500);
}

async function wslRemoteResources(distro) {
  showToast('Obteniendo recursos remotos…', 'info');
  // Switch resource monitor to remote mode (auto-refresh calls remoteResources)
  _wslRes.distro   = null;             // prevent local auto-refresh
  _wslRes.remote   = true;
  _wslRes.remDist  = distro;
  clearInterval(_wslRes.timer);
  _wslRes.timer = null;

  const modal  = document.getElementById('wsl-res-modal');
  const nameEl = document.getElementById('wsl-res-distro-name');
  if (nameEl) nameEl.textContent = distro + ' — ' + remoteState.host;
  if (modal) modal.style.display = 'flex';

  // Show "REMOTO" badge instead of Auto
  const badge = document.getElementById('wsl-res-refresh-badge');
  if (badge) { badge.textContent = '🌐 REMOTO'; badge.style.background = '#7c3aed'; }

  await _wslFetchRemoteResources(distro);

  // Set auto-refresh every 8s for remote (slower due to SSH roundtrip)
  _wslRes.timer = setInterval(() => _wslFetchRemoteResources(_wslRes.remDist), 8000);
}

async function _wslFetchRemoteResources(distro) {
  const res = await api.wslRemoteResources({
    host: remoteState.host, port: remoteState.port,
    user: remoteState.user, password: remoteState.password,
    gatewayDistro: remoteState.gatewayDistro, distro,
  }).catch(() => ({ ok: false }));

  if (!res.ok) {
    const lu = document.getElementById('wsl-res-last-update');
    if (lu) lu.textContent = 'Error: ' + (res.error || 'Sin respuesta');
    return;
  }
  _wslResRenderCPU(res.ps);
  _wslResRenderMem(res.mem);
  _wslResRenderDisk(res.df);
  _wslResRenderPorts(res.ports);
  const lu = document.getElementById('wsl-res-last-update');
  if (lu) lu.textContent = '🌐 Remoto · Actualizado: ' + new Date().toLocaleTimeString();
}

async function wslRemoteTerminal(distro) {
  // Use the SSH floating terminal to connect to the remote distro
  const sid = 'remote-' + Date.now();
  sshTerm.streamId  = sid;
  sshTerm.connected = true;
  sshTerm.mode = 'remote';

  // Show the floating terminal panel
  const pane = document.getElementById('ssh-pane-terminal');
  if (pane) {
    if (!pane.classList.contains('ssh-floating')) {
      pane.classList.add('ssh-floating');
      const handle = document.getElementById('ssh-float-handle');
      if (handle) _sshInitDrag(pane, handle);
    }
    pane.style.display = 'flex';
  }
  const form = document.getElementById('ssh-conn-form');
  const wrap = document.getElementById('ssh-term-wrap');
  if (form) form.style.display = 'none';
  if (wrap) { wrap.style.display = 'flex'; wrap.style.flexDirection = 'column'; }

  const titleEl = document.getElementById('ssh-term-title');
  if (titleEl) titleEl.textContent = distro + ' @ ' + remoteState.host;
  const connLabelEl = document.getElementById('ssh-term-conn-label');
  if (connLabelEl) connLabelEl.textContent = distro + ' @ ' + remoteState.host;
  const dotEl = document.getElementById('ssh-status-dot');
  if (dotEl) { dotEl.textContent = '●'; dotEl.style.color = '#4ade80'; }

  const termEl = document.getElementById('ssh-terminal');
  if (termEl) { termEl.innerHTML = ''; termEl._ansi = new AnsiTerminal(termEl); }
  if (termEl?._ansi) termEl._ansi.write('\x1b[33mConectando a ' + distro + ' @ ' + remoteState.host + '…\x1b[0m\r\n');

  _sshWireInput();
  setTimeout(() => document.getElementById('ssh-term-input')?.focus(), 80);

  const res = await api.wslRemoteShell({
    host: remoteState.host, port: remoteState.port,
    user: remoteState.user, password: remoteState.password,
    gatewayDistro: remoteState.gatewayDistro, distro,
  }, sid).catch(e => ({ ok: false, error: e.message }));

  if (!res?.ok) {
    if (termEl?._ansi) termEl._ansi.write('\x1b[31m[Error: ' + escHtml(res?.error || 'desconocido') + ']\x1b[0m\r\n');
    sshTerm.streamId = null; sshTerm.connected = false;
    showToast('Error al conectar: ' + (res?.error || ''), 'error');
  }
}

// ── SSH ───────────────────────────────────────────────────────────
async function wslRefreshSsh() {
  if (!wslState.selected) return;
  const res = await api.wslSshStatus(wslState.selected).catch(() => ({ ok: false }));
  if (!res.ok) { wslLogMini('wsl-ssh-log', `Error: ${res.error}\n`); return; }
  wslState.sshInfo = res;
  const set = (id, v) => { const e = $wsl(id); if (e) e.textContent = v; };
  set('ssh-installed', res.installed ? '✅ Sí' : '❌ No');
  set('ssh-running',   res.running   ? '✅ Activo' : '⏸ Parado');
  set('ssh-port',      res.port);
  set('ssh-user',      res.user);
  set('ssh-ip',        res.ip);
  wslLogMini('wsl-ssh-log', `[SSH] Puerto:${res.port} Usuario:${res.user} IP:${res.ip}\n`);
}

function wslSshInstall() {
  if (!wslRequireSelected()) return;
  const d   = wslState.selected.toLowerCase();
  let key   = 'ssh:install:deb';
  if (['alma','rocky','fedora','oracle','centos'].some(k => d.includes(k))) key = 'ssh:install:rpm';
  else if (d.includes('arch')) key = 'ssh:install:pac';
  else if (d.includes('suse')) key = 'ssh:install:zpp';

  const sid = 'wsl-ssh-' + Date.now();
  wslLogMini('wsl-ssh-log', `[>] Instalando openssh-server...\n`);
  wslLog('Instalando openssh-server en ' + wslState.selected + '...', 'cmd');
  api.wslStreamPreset(wslState.selected, key, sid);
  wslState._sshStreamId = sid;
  // output arrives via stream:data → wslHandleStreamData → wslLogMini
}

function wslSshPreset(preset) {
  if (!wslRequireSelected()) return;
  const id = `wsl-ssh-${Date.now()}`;
  wslLogMini('wsl-ssh-log', `[>] ${preset}\n`);
  api.wslStreamPreset(wslState.selected, preset, id);
  // Los datos llegan por stream:data (ya registrado en app init)
  // Los recibimos en el handler global de stream y los redirigimos
  wslState._sshStreamId = id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TERMINAL SSH EMBEBIDA — AnsiTerminal + controles
// ═══════════════════════════════════════════════════════════════════════════════

class AnsiTerminal {
  constructor(el) {
    this.el   = el;
    this._buf = '';
    this._html = '';
    this._style = '';   // current open span style ('' = none)
  }

  write(data) {
    this._buf += data;
    this._flush();
  }

  _flush() {
    let i = 0, out = '';
    const buf = this._buf, len = buf.length;

    while (i < len) {
      const ch = buf[i];

      if (ch === '\x1b') {
        if (i + 1 >= len) break;
        const nxt = buf[i + 1];

        if (nxt === '[') {
          let j = i + 2;
          while (j < len && (buf.charCodeAt(j) < 0x40 || buf.charCodeAt(j) > 0x7e)) j++;
          if (j >= len) break;
          const param = buf.slice(i + 2, j);
          const cmd   = buf[j];
          i = j + 1;
          if (cmd === 'm') {
            if (this._style) { out += '</span>'; this._style = ''; }
            const st = this._sgr(param);
            if (st) { out += '<span style="' + st + '">'; this._style = st; }
          } else if (cmd === 'J') {
            // clear screen
            if (this._style) { out += '</span>'; this._style = ''; }
            this._html = ''; out = '';
            this.el.innerHTML = '';
          }
          // other CSI (K, A-D, H, etc.) — ignored for pipe mode
        } else if (nxt === ']') {
          let j = i + 2;
          while (j < len && buf[j] !== '\x07' && buf[j] !== '\x1b') j++;
          i = (j < len && buf[j] === '\x07') ? j + 1 : j;
        } else {
          i += 2;
        }

      } else if (ch === '\r') {
        // Carriage return: strip back to last \n in pending out, then in committed html
        const nl = out.lastIndexOf('\n');
        if (nl >= 0) {
          out = out.slice(0, nl + 1);
        } else {
          const nh = this._html.lastIndexOf('\n');
          this._html = nh >= 0 ? this._html.slice(0, nh + 1) : '';
          out = '';
        }
        // Re-open style span if needed
        if (this._style) out += '</span><span style="' + this._style + '">';
        i++;
      } else if (ch === '\n') {
        out += '\n'; i++;
      } else if (ch === '\x07' || ch === '\x00') {
        i++;
      } else if (ch === '\x08') {
        // backspace: remove last printable char from out
        if (out.length > 0) out = out.slice(0, -1);
        i++;
      } else {
        out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
        i++;
      }
    }

    this._buf = buf.slice(i);
    if (!out) return;
    this._html += out;
    this.el.innerHTML = this._html + (this._style ? '</span>' : '');
    this.el.scrollTop = this.el.scrollHeight;
  }

  _sgr(params) {
    const nums = params ? params.split(';').map(Number) : [0];
    let fg=null,bg=null,bold=false,dim=false,ul=false,inv=false;
    let i=0;
    while (i < nums.length) {
      const n=nums[i];
      if (n===0){fg=null;bg=null;bold=false;dim=false;ul=false;inv=false;}
      else if(n===1)bold=true; else if(n===2)dim=true;
      else if(n===4)ul=true;   else if(n===7)inv=true;
      else if(n>=30&&n<=37)fg=this._c16(n-30,false);
      else if(n===38&&nums[i+1]===5){fg=this._c256(nums[i+2]);i+=2;}
      else if(n===38&&nums[i+1]===2){fg='rgb('+nums[i+2]+','+nums[i+3]+','+nums[i+4]+')';i+=4;}
      else if(n===39)fg=null;
      else if(n>=40&&n<=47)bg=this._c16(n-40,false);
      else if(n===48&&nums[i+1]===5){bg=this._c256(nums[i+2]);i+=2;}
      else if(n===48&&nums[i+1]===2){bg='rgb('+nums[i+2]+','+nums[i+3]+','+nums[i+4]+')';i+=4;}
      else if(n===49)bg=null;
      else if(n>=90&&n<=97)fg=this._c16(n-90,true);
      else if(n>=100&&n<=107)bg=this._c16(n-100,true);
      i++;
    }
    if(inv){[fg,bg]=[bg||'#ccc',fg||'#000'];}
    let s='';
    if(fg)s+='color:'+fg+';';
    if(bg)s+='background:'+bg+';';
    if(bold)s+='font-weight:bold;';
    if(dim)s+='opacity:.6;';
    if(ul)s+='text-decoration:underline;';
    return s;
  }

  _c16(n,b){
    const D=['#000','#c00','#0a0','#a50','#00c','#a0a','#0aa','#aaa'];
    const B=['#555','#f55','#5f5','#ff5','#55f','#f5f','#5ff','#fff'];
    return (b?B:D)[n]||'#aaa';
  }

  _c256(n){
    if(n<8)return this._c16(n,false);
    if(n<16)return this._c16(n-8,true);
    if(n<232){const i=n-16,b=i%6,g=Math.floor(i/6)%6,r=Math.floor(i/36),v=x=>x?x*40+55:0;return 'rgb('+v(r)+','+v(g)+','+v(b)+')';}
    const v=Math.round((n-232)*10.2+8);return 'rgb('+v+','+v+','+v+')';
  }

  clear(){this._html='';this._style='';this._buf='';this.el.innerHTML='';}
}

// ── SSH terminal state ────────────────────────────────────────────────────────
const sshTerm = {
  streamId:  null,
  mode:      'wsl',
  history:   [],
  histIdx:   -1,
  connected: false,
  _inputWired: false,
};

function switchSshTab(tab) {
  if (tab === 'terminal') {
    const pane = document.getElementById('ssh-pane-terminal');
    if (!pane) return;
    pane.style.display = 'flex';
    pane.style.flexDirection = 'column';
    pane.classList.add('ssh-floating');
    if (!pane._floatReady) {
      pane._floatReady = true;
      pane.style.top    = '70px';
      pane.style.right  = '16px';
      pane.style.left   = 'auto';
      pane.style.bottom = 'auto';
      const handle = document.getElementById('ssh-float-handle');
      if (handle) _sshInitDrag(pane, handle);
    }
    document.getElementById('ssh-tab-status')?.classList.add('active');
    document.getElementById('ssh-tab-terminal')?.classList.remove('active');
    return;
  }
  const floatPane = document.getElementById('ssh-pane-terminal');
  if (floatPane) { floatPane.classList.remove('ssh-floating'); floatPane.style.display = 'none'; }
  ['status','terminal'].forEach(t => {
    const pane = document.getElementById('ssh-pane-' + t);
    const btn  = document.getElementById('ssh-tab-'  + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    if (btn)  btn.classList.toggle('active', t === tab);
  });
}

function _sshInitDrag(el, handle) {
  let ox=0,oy=0;
  handle.addEventListener('mousedown', e => {
    if (e.button!==0) return;
    e.preventDefault();
    const r=el.getBoundingClientRect(); ox=e.clientX-r.left; oy=e.clientY-r.top;
    const mv = e2 => { el.style.left=Math.max(0,e2.clientX-ox)+'px'; el.style.top=Math.max(0,e2.clientY-oy)+'px'; el.style.right='auto'; };
    const up = () => { document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
  });
}

let _sshMinimized=false;
function sshTermMinimize() {
  const pane=document.getElementById('ssh-pane-terminal');
  if (!pane) return;
  _sshMinimized=!_sshMinimized;
  const body=document.getElementById('ssh-float-body');
  if (body) body.style.display=_sshMinimized?'none':'flex';
  const btn=document.getElementById('ssh-min-btn');
  if (btn) btn.textContent=_sshMinimized?'🗖':'🗕';
}

function sshTermFloatClose() {
  const pane=document.getElementById('ssh-pane-terminal');
  if (pane) { pane.style.display='none'; pane.classList.remove('ssh-floating'); }
  document.getElementById('ssh-tab-status')?.classList.add('active');
  document.getElementById('ssh-tab-terminal')?.classList.remove('active');
  showToast('Terminal en segundo plano — clic en Terminal para volver.','info',3000);
}

function setSshConnMode(mode) {
  sshTerm.mode = mode;
  ['wsl','ssh'].forEach(m => {
    const btn  = document.getElementById('ssh-mode-' + m);
    const form = document.getElementById('ssh-form-' + m);
    if (btn)  btn.classList.toggle('active', m === mode);
    if (form) form.style.display = m === mode ? 'flex' : 'none';
  });
  if (mode === 'ssh' && wslState.sshInfo) {
    const u = document.getElementById('ssh-f-user');
    const p = document.getElementById('ssh-f-port');
    if (u && wslState.sshInfo.user) u.value = wslState.sshInfo.user;
    if (p && wslState.sshInfo.port) p.value = wslState.sshInfo.port;
  }
}

async function sshTermConnect() {
  if (!wslRequireSelected()) return;
  const distro = wslState.selected;
  const sid    = 'ssh-' + Date.now();
  sshTerm.streamId = sid;

  let res;
  if (sshTerm.mode === 'wsl') {
    res = await api.wslOpenShell(distro, sid).catch(e => ({ ok: false, error: e.message }));
  } else {
    const host = (document.getElementById('ssh-f-host')?.value || '').trim();
    const port = parseInt(document.getElementById('ssh-f-port')?.value || '22', 10) || 22;
    const user = (document.getElementById('ssh-f-user')?.value || '').trim();
    const pass = document.getElementById('ssh-f-pass')?.value || '';
    if (!host || !user) { showToast('Introduce host y usuario', 'warn'); return; }
    res = await api.wslSshConnect(
        { host, port, user, password: pass, gatewayDistro: wslState.selected || '' }, sid)
      .catch(e => ({ ok: false, error: e.message }));
  }

  if (!res?.ok) {
    showToast('Error: ' + (res?.error || 'No se pudo conectar'), 'error');
    sshTerm.streamId = null;
    return;
  }

  sshTerm.connected = true;
  sshTerm.history   = [];
  sshTerm.histIdx   = -1;

  const form = document.getElementById('ssh-conn-form');
  const wrap = document.getElementById('ssh-term-wrap');
  if (form) form.style.display = 'none';
  if (wrap) { wrap.style.display = 'flex'; wrap.style.flexDirection = 'column'; }

  const connLabel = sshTerm.mode === 'wsl'
    ? 'Shell — ' + distro
    : (document.getElementById('ssh-f-user')?.value||'?') + '@' + (document.getElementById('ssh-f-host')?.value||'?');
  const titleEl = document.getElementById('ssh-term-title');
  if (titleEl) titleEl.textContent = connLabel;
  const connLabelEl = document.getElementById('ssh-term-conn-label');
  if (connLabelEl) connLabelEl.textContent = connLabel;
  const dotEl = document.getElementById('ssh-status-dot');
  if (dotEl) { dotEl.textContent = '●'; dotEl.style.color = '#4ade80'; }

  const termEl = document.getElementById('ssh-terminal');
  if (termEl) { termEl.innerHTML = ''; termEl._ansi = new AnsiTerminal(termEl); }

  _sshWireInput();
  setTimeout(() => document.getElementById('ssh-term-input')?.focus(), 80);
}

// Send input via button click (same as pressing Enter)
function sshTermSendInput() {
  const inp = document.getElementById('ssh-term-input');
  if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function sshTermDisconnect() {
  if (sshTerm.streamId) { api.killStream(sshTerm.streamId); sshTerm.streamId = null; }
  sshTerm.connected = false;
  const form = document.getElementById('ssh-conn-form');
  const wrap = document.getElementById('ssh-term-wrap');
  if (form) form.style.display = 'flex';
  if (wrap) wrap.style.display = 'none';
}

function sshTermClear() {
  const t = document.getElementById('ssh-terminal');
  if (t?._ansi) t._ansi.clear();
}

function sshHandleStreamData(streamId, data) {
  if (streamId !== sshTerm.streamId) return false;
  const t = document.getElementById('ssh-terminal');
  if (t) { if (!t._ansi) t._ansi = new AnsiTerminal(t); t._ansi.write(data); }
  return true;
}

function sshHandleStreamEnd(streamId, code) {
  if (streamId !== sshTerm.streamId) return false;
  sshTerm.streamId  = null;
  sshTerm.connected = false;
  const t = document.getElementById('ssh-terminal');
  if (t?._ansi) t._ansi.write('\r\n\x1b[90m[Sesion terminada — codigo ' + code + ']\x1b[0m\r\n');
  const ti = document.getElementById('ssh-term-title');
  if (ti) ti.textContent = 'Desconectado';
  const cl = document.getElementById('ssh-term-conn-label');
  if (cl) cl.textContent = 'Sesión terminada';
  const dot = document.getElementById('ssh-status-dot');
  if (dot) { dot.textContent = '○'; dot.style.color = '#888'; }
  return true;
}

function _sshWireInput() {
  if (sshTerm._inputWired) return;
  sshTerm._inputWired = true;
  const inp = document.getElementById('ssh-term-input');
  if (!inp) return;
  inp.addEventListener('keydown', e => {
    if (!sshTerm.streamId) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = inp.value;
      // Local echo — bash in pipe mode doesn't echo input back
      const termEl = document.getElementById('ssh-terminal');
      if (termEl?._ansi && line) {
        termEl._ansi.write('\x1b[32m$\x1b[0m ' + line + '\r\n');
      }
      // Visual "sent" flash on the prompt label
      const lbl = document.getElementById('ssh-prompt-label');
      if (lbl) { lbl.textContent = '✓'; lbl.style.color = 'var(--green)'; setTimeout(() => { lbl.textContent = '$'; lbl.style.color = ''; }, 400); }
      api.streamStdin(sshTerm.streamId, line + '\n');
      if (line.trim()) { sshTerm.history.unshift(line); if (sshTerm.history.length > 200) sshTerm.history.pop(); }
      sshTerm.histIdx = -1;
      inp.value = '';
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      api.streamStdin(sshTerm.streamId, '\x03');
      inp.value = '';
    } else if (e.key === 'd' && e.ctrlKey) {
      e.preventDefault(); api.streamStdin(sshTerm.streamId, '\x04');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault(); sshTermClear();
    } else if (e.key === 'Tab') {
      e.preventDefault(); api.streamStdin(sshTerm.streamId, '\t');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sshTerm.histIdx = Math.min(sshTerm.histIdx + 1, sshTerm.history.length - 1);
      inp.value = sshTerm.history[sshTerm.histIdx] || '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      sshTerm.histIdx = Math.max(sshTerm.histIdx - 1, -1);
      inp.value = sshTerm.histIdx >= 0 ? sshTerm.history[sshTerm.histIdx] : '';
    }
  });
}

// Legacy alias kept for any remaining onclick refs
function wslSshConnect() { switchSshTab('terminal'); }

// Port editor toggle
function togglePortEditor() {
  const el = document.getElementById('ssh-port-editor');
  if (!el) return;
  const showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : 'flex';
  if (!showing) {
    const inp = document.getElementById('ssh-port-input');
    if (inp) { inp.value = wslState.sshInfo?.port || '22'; inp.focus(); inp.select(); }
  }
}

async function wslSshApplyPort() {
  const inp = document.getElementById('ssh-port-input');
  const np  = parseInt(inp?.value || '0');
  if (!np || np < 1 || np > 65535) { showToast('Puerto inválido (1-65535)', 'warn'); return; }
  if (!wslRequireSelected()) return;
  const res = await api.wslSshChangePort(wslState.selected, np).catch(() => ({ ok: false }));
  wslLogMini('wsl-ssh-log', res.ok ? `[OK] Puerto cambiado a ${np}\n` : `[ERROR] ${res.output || 'Error'}\n`);
  if (res.ok) { togglePortEditor(); wslRefreshSsh(); }
  else showToast('Error al cambiar puerto', 'error');
}

// Legacy alias
async function wslSshChangePort() { togglePortEditor(); }

// Open WSL vhdx directory — use selected distro's known storage path
async function wslOpenVhdxDir() {
  // Try to use the selected distro's BasePath from the list
  const distro = wslState.distros?.find(d => d.name === wslState.selected);
  const distroPath = distro?.path || '';
  const res = await api.wslOpenVhdxDir({ distroPath }).catch(() => null);
  if (!res?.ok) showToast('No se pudo abrir el directorio WSL', 'warn');
  else if (res.path) showToast('Abriendo: ' + res.path, 'info', 3000);
}

// ── Right-click context menu ──────────────────────────────────────
let _ctxTarget = null;
function wslCtxMenu(e, name) {
  e.preventDefault();
  e.stopPropagation();
  wslSetSelected(name, false);
  _ctxTarget = name;
  const menu = document.getElementById('wsl-ctx-menu');
  if (!menu) return;
  // Restore delete item visibility for local distros
  const delItem = menu.querySelector('[onclick*="wslCtxDelete"]');
  if (delItem) delItem.style.display = '';
  menu.style.display = 'block';
  // Position near cursor, keep inside viewport
  const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}
function wslCtxClose() {
  const m = document.getElementById('wsl-ctx-menu');
  if (m) m.style.display = 'none';
}
function wslCtxAction(action) {
  wslCtxClose();
  if (!_ctxTarget) return;
  wslSetSelected(_ctxTarget);
  wslActionSel(action);
}
async function wslCtxDelete() {
  wslCtxClose();
  if (!_ctxTarget) return;
  wslSetSelected(_ctxTarget);
  await wslDelete();
}
// Close context menu on any click
document.addEventListener('click', wslCtxClose);
document.addEventListener('keydown', e => { if (e.key === 'Escape') wslCtxClose(); });

// ── Montajes ──────────────────────────────────────────────────────
async function wslRefreshMounts() {
  if (!wslState.selected) return;
  const tbody = $wsl('wsl-mounts-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="wsl-empty">Cargando…</td></tr>';
  const res = await api.wslGetMounts(wslState.selected).catch(() => ({ ok: false, rows: [] }));
  if (!tbody) return;
  if (!res.ok || !res.rows?.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="wsl-empty">${escHtml(res.error || 'Sin mounts')}</td></tr>`;
    return;
  }
  tbody.innerHTML = res.rows.map(r =>
    `<tr><td>${escHtml(r.source)}</td><td>${escHtml(r.target)}</td><td>${escHtml(r.fstype)}</td><td style="font-size:10px;color:var(--text-2)">${escHtml(r.options)}</td></tr>`
  ).join('');
}

async function wslPickBindSrc() {
  const res = await api.openFolder().catch(() => null);
  if (res) { const el = $wsl('wsl-bind-src'); if (el) el.value = res; }
}

function wslBindMount() {
  if (!wslRequireSelected()) return;
  const src = $wsl('wsl-bind-src')?.value?.trim();
  const dst = $wsl('wsl-bind-dst')?.value?.trim();
  if (!src || !dst) { showToast('Indica carpeta origen y punto de montaje', 'warn'); return; }
  const id = `wsl-bind-${Date.now()}`;
  wslLogMini('wsl-mounts-log', `[bind] ${src} → ${dst}\n`);
  api.wslStreamBindMount(wslState.selected, src, dst, id);
  wslState._mountStreamId = id;
}

async function wslListDisks() {
  const res = await api.wslListDisks().catch(() => ({ ok: false, disks: [] }));
  const el = $wsl('wsl-disks-list');
  if (!el) return;
  if (!res.ok || !res.disks?.length) {
    el.innerHTML = '<span style="color:var(--text-3)">Sin discos detectados</span>';
    return;
  }
  el.innerHTML = res.disks.map(d =>
    `<div class="wsl-disk-row">
      <span style="color:var(--cyan)">${escHtml(d.DeviceID)}</span>
      <span>${escHtml(d.Model)}</span>
      <span style="color:var(--text-2)">${d.SizeGB ?? '?'} GB</span>
    </div>`
  ).join('');
}

// ── Transferencia ─────────────────────────────────────────────────
async function wslInitTransfer() {
  if (!wslState.selected) return;
  // Obtener HOME del usuario para usarlo como destino por defecto
  const dst = $wsl('wsl-transfer-dst');
  if (dst && dst.value === '/root/desde_windows') {
    // Intentar obtener HOME real
    try {
      const res = await api.wslGetResources(wslState.selected);
      // Si hay un home distinto de /root, usarlo
    } catch {}
  }
  wslRenderTransferList();
}

function wslRenderTransferList() {
  const ul = $wsl('wsl-transfer-list');
  if (!ul) return;
  ul.innerHTML = '';
  wslState.transferFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>📄</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis" title="${escHtml(f)}">${escHtml(f)}</span>
      <button class="wsl-file-rm" onclick="wslTransferRemove(${i})">✕</button>`;
    ul.appendChild(li);
  });
}

async function wslTransferAddFiles() {
  const res = await api.openFile({ properties: ['openFile','multiSelections'] }).catch(() => null);
  if (!res) return;
  const files = Array.isArray(res) ? res : [res];
  wslState.transferFiles.push(...files.filter(f => f && !wslState.transferFiles.includes(f)));
  wslRenderTransferList();
}

async function wslTransferAddFolder() {
  const res = await api.openFolder().catch(() => null);
  if (res && !wslState.transferFiles.includes(res)) {
    wslState.transferFiles.push(res);
    wslRenderTransferList();
  }
}

function wslTransferRemove(idx) {
  wslState.transferFiles.splice(idx, 1);
  wslRenderTransferList();
}

function wslTransferClear() {
  wslState.transferFiles = [];
  wslRenderTransferList();
}

function wslDoTransfer() {
  if (!wslRequireSelected()) return;
  if (!wslState.transferFiles.length) { showToast('Agrega archivos o carpetas primero', 'warn'); return; }
  const dst = $wsl('wsl-transfer-dst')?.value?.trim();
  if (!dst) { showToast('Indica la ruta destino', 'warn'); return; }
  if (!confirm(`¿Copiar ${wslState.transferFiles.length} elemento(s) a '${wslState.selected}:${dst}'?`)) return;
  const id = `wsl-transfer-${Date.now()}`;
  const logEl = $wsl('wsl-transfer-log');
  if (logEl) logEl.textContent = '';
  wslLogMini('wsl-transfer-log', `Iniciando transferencia a ${dst}…\n`);
  api.wslStreamTransfer(wslState.selected, wslState.transferFiles, dst, id);
  wslState._transferStreamId = id;
}

async function wslTransferOpenExplorer() {
  if (!wslRequireSelected()) return;
  await api.wslOpenExplorer(wslState.selected);
}

async function wslTransferOpenHome() {
  if (!wslRequireSelected()) return;
  // Usar el explorador que apunta al home de la distro
  await api.wslOpenExplorer(wslState.selected);
}

// ── Modal genérico de info ────────────────────────────────────────
function showInfoModal(title, content) {
  // Reutilizar un modal simple si no existe, o mostrar en un nuevo popup
  let modal = document.getElementById('info-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'info-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="width:700px;max-width:95vw">
        <div class="modal-header">
          <span id="info-modal-title"></span>
          <button class="btn-close-panel" onclick="document.getElementById('info-modal').style.display='none'">✕</button>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow-y:auto">
          <pre id="info-modal-body" style="margin:0;font-size:11px;font-family:monospace;color:var(--text-1);white-space:pre-wrap;word-break:break-all"></pre>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('info-modal-title').textContent = title;
  document.getElementById('info-modal-body').textContent  = content;
  modal.style.display = 'flex';
}

function closeInfoModal() {
  const modal = document.getElementById('info-modal');
  if (modal) modal.style.display = 'none';
}

// ── Interceptar streams WSL en el handler global ──────────────────
// (Se agrega al inicio de la app al registrar los listeners de stream)
function wslHandleStreamData(streamId, data) {
  if (streamId === wslState._sshStreamId)      { wslLogMini('wsl-ssh-log',      data); return true; }
  if (streamId === wslState._mountStreamId)    { wslLogMini('wsl-mounts-log',   data); return true; }
  if (streamId === wslState._transferStreamId) { wslLogMini('wsl-transfer-log', data); return true; }
  if (streamId === wslState._pkgStreamId)      { wslLog(data.replace(/\r?\n/g,''), 'info'); return true; }
  return false;
}

function wslHandleStreamEnd(streamId, code) {
  if (streamId === wslState._sshStreamId) {
    wslLogMini('wsl-ssh-log', code === 0 ? '[OK]\n' : `[Exit: ${code}]\n`);
    setTimeout(wslRefreshSsh, 1500);
    wslState._sshStreamId = null; return true;
  }
  if (streamId === wslState._mountStreamId) {
    wslLogMini('wsl-mounts-log', code === 0 ? '[OK]\n' : `[Exit: ${code}]\n`);
    setTimeout(wslRefreshMounts, 1500);
    wslState._mountStreamId = null; return true;
  }
  if (streamId === wslState._transferStreamId) {
    wslLogMini('wsl-transfer-log', code === 0 ? '[OK] Completado\n' : '[Exit: ' + code + ']\n');
    wslState._transferStreamId = null; return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPLORADOR DE CONTENEDORES
// ═══════════════════════════════════════════════════════════════════════════════

const explorerState = {
  containerId:   null,
  containerName: null,
  currentPath:   '/',
  history:       ['/'],
  selected:      null,
  desktop:       null,
  dbType:        null,
  currentDb:     null,
  pgUser:        null,
  pgPwd:         null,   // contraseña postgres (si auth por password)
  rootPwd:       null,
  maximized:     false,  // estado maximizado de la ventana
  savedBounds:   null,   // posicion guardada antes de maximizar
};

// ── Drag & Resize de la ventana flotante ─────────────────────────────────────
(function initExplorerWindow() {
  let dragging = false, ox = 0, oy = 0, sx = 0, sy = 0;
  document.addEventListener('DOMContentLoaded', () => {
    const win    = $id('explorer-modal');
    const handle = $id('explorer-drag-handle');
    if (!win || !handle) return;

    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      dragging = true;
      // Si tiene transform: translate centrado, convertirlo a left/top absolutas
      const rect = win.getBoundingClientRect();
      win.style.transform = 'none';
      win.style.left = rect.left + 'px';
      win.style.top  = rect.top  + 'px';
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup',   stopDrag);
    });

    function onDrag(e) {
      if (!dragging) return;
      let nx = e.clientX - ox;
      let ny = e.clientY - oy;
      // Mantener dentro de la pantalla
      nx = Math.max(0, Math.min(nx, window.innerWidth  - win.offsetWidth));
      ny = Math.max(0, Math.min(ny, window.innerHeight - win.offsetHeight));
      win.style.left = nx + 'px';
      win.style.top  = ny + 'px';
    }
    function stopDrag() {
      dragging = false;
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup',   stopDrag);
    }
  });
})();

function explorerToggleMaximize() {
  const win = $id('explorer-modal');
  if (!explorerState.maximized) {
    explorerState.savedBounds = {
      left: win.style.left, top: win.style.top,
      width: win.style.width, height: win.style.height,
      transform: win.style.transform,
    };
    win.style.transform = 'none';
    win.style.left   = '0'; win.style.top    = '0';
    win.style.width  = '100vw'; win.style.height = '100vh';
    win.style.borderRadius = '0';
    explorerState.maximized = true;
  } else {
    const b = explorerState.savedBounds || {};
    win.style.left   = b.left   || '50%';
    win.style.top    = b.top    || '50%';
    win.style.width  = b.width  || '';
    win.style.height = b.height || '';
    win.style.transform = b.transform || 'translate(-50%,-50%)';
    win.style.borderRadius = '';
    explorerState.maximized = false;
  }
}

async function openContainerExplorer(id, name) {
  explorerState.containerId   = id;
  explorerState.containerName = name || id.slice(0, 12);
  explorerState.currentPath   = '/';
  explorerState.history       = ['/'];
  explorerState.selected      = null;
  explorerState.dbType        = null;
  explorerState.currentDb     = null;
  explorerState.pgUser        = null;
  explorerState.pgPwd         = null;
  explorerState.rootPwd       = null;

  $id('explorer-container-name').textContent = explorerState.containerName;
  // Limpiar estado BD
  const credForm = $id('db-credentials-form');
  if (credForm) credForm.style.display = 'none';
  const badge = $id('db-type-badge');
  if (badge) { badge.className = 'db-badge'; badge.textContent = 'Sin detectar'; }
  switchExplorerTab('files');
  $id('explorer-modal').style.display = 'flex';

  // Pre-cargar ruta del escritorio
  const dr = await api.containerGetDesktop().catch(() => ({ ok: false }));
  explorerState.desktop = dr.ok ? dr.path : null;

  await explorerLoadDir('/');
}

function closeExplorer() {
  $id('explorer-modal').style.display = 'none';
}

function switchExplorerTab(tab) {
  ['files', 'db', 'net'].forEach(t => {
    const panel = $id('explorer-panel-' + t);
    const btn   = $id('etab-' + t);
    if (panel) panel.style.display = t === tab ? 'flex' : 'none';
    if (btn)   btn.classList.toggle('active', t === tab);
  });
  const active = $id('explorer-panel-' + tab);
  if (active) active.style.flexDirection = 'column';
  if (tab === 'net') explorerLoadNetworkInfo();
}

async function explorerLoadDir(dirPath) {
  explorerState.currentPath = dirPath;
  $id('explorer-current-path').textContent = dirPath;
  $id('explorer-copy-btn').style.display = 'none';
  explorerState.selected = null;

  // Breadcrumb
  renderExplorerBreadcrumb(dirPath);

  const treeEl = $id('explorer-tree');
  treeEl.innerHTML = '<div class="explorer-loading"><div class="spinner"></div>Cargando…</div>';

  const res = await api.containerListDir(explorerState.containerId, dirPath)
    .catch(e => ({ ok: false, error: e.message }));

  if (!res.ok) {
    treeEl.innerHTML = `<div class="explorer-loading" style="color:var(--red)">✗ ${escHtml(res.error || 'Error')}</div>`;
    return;
  }

  if (!res.entries.length) {
    treeEl.innerHTML = '<div class="explorer-loading" style="color:var(--text-3)">Directorio vacío</div>';
    return;
  }

  // Ordenar: dirs primero, luego archivos, alfabético
  const sorted = [...res.entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  treeEl.innerHTML = '';
  sorted.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'explorer-item';
    const icon = entry.isLink ? '🔗' : entry.isDir ? '📁' : getFileIcon(entry.name);
    const sizeStr = entry.isDir ? '' : humanFileSize(entry.size);
    div.innerHTML = `
      <span class="explorer-item-icon">${icon}</span>
      <span class="explorer-item-name">${escHtml(entry.name)}</span>
      <span class="explorer-item-size">${sizeStr}</span>`;

    if (entry.isDir) {
      div.ondblclick = () => {
        const next = explorerState.currentPath.replace(/\/$/, '') + '/' + entry.name;
        explorerState.history.push(next);
        explorerLoadDir(next);
      };
      div.onclick = () => {
        document.querySelectorAll('.explorer-item').forEach(e => e.classList.remove('selected'));
        div.classList.add('selected');
        explorerShowDetail(entry, explorerState.currentPath);
      };
    } else {
      div.onclick = () => {
        document.querySelectorAll('.explorer-item').forEach(e => e.classList.remove('selected'));
        div.classList.add('selected');
        explorerState.selected = entry;
        explorerShowDetail(entry, explorerState.currentPath);
        $id('explorer-copy-btn').style.display = '';
      };
    }
    treeEl.appendChild(div);
  });
}

function renderExplorerBreadcrumb(dirPath) {
  const bc = $id('explorer-breadcrumb');
  const parts = dirPath.split('/').filter(Boolean);
  let html = `<span class="explorer-breadcrumb-part" onclick="explorerGoto('/')">🏠</span>`;
  let accum = '';
  parts.forEach((p, i) => {
    accum += '/' + p;
    const path = accum;
    html += `<span class="explorer-breadcrumb-sep">/</span>
             <span class="explorer-breadcrumb-part" onclick="explorerGoto('${escHtml(path)}')">${escHtml(p)}</span>`;
  });
  bc.innerHTML = html;
}

function explorerGoto(path) {
  explorerState.history.push(path);
  explorerLoadDir(path);
}

function explorerGoUp() {
  const parts = explorerState.currentPath.split('/').filter(Boolean);
  if (!parts.length) return;
  parts.pop();
  const parent = '/' + parts.join('/') || '/';
  explorerGoto(parent);
}

function explorerRefresh() {
  explorerLoadDir(explorerState.currentPath);
}

function explorerShowDetail(entry, dir) {
  const fullPath = dir.replace(/\/$/, '') + '/' + entry.name;
  const detail = $id('explorer-detail');
  detail.className = 'explorer-file-detail';
  detail.innerHTML = `
    <div class="explorer-file-detail-name">${escHtml(entry.name)}</div>
    <table>
      <tr><td>Ruta completa</td><td><code>${escHtml(fullPath)}</code></td></tr>
      <tr><td>Tipo</td><td>${entry.isLink ? 'Enlace simbólico' : entry.isDir ? 'Directorio' : 'Archivo'}</td></tr>
      ${!entry.isDir ? `<tr><td>Tamaño</td><td>${humanFileSize(entry.size)}</td></tr>` : ''}
      <tr><td>Permisos</td><td><code>${escHtml(entry.perms)}</code></td></tr>
    </table>
    ${!entry.isDir ? `
    <div class="explorer-copy-zone">
      <div style="font-size:12px;color:var(--text-2);margin-bottom:8px">
        📂 Destino: <code>${escHtml(explorerState.desktop || os.homedir())}</code>
      </div>
      <button class="btn blue" onclick="explorerCopyToDesktop()">
        💾 Copiar al escritorio de Windows
      </button>
    </div>` : ''}`;
}

async function explorerCopyToDesktop() {
  if (!explorerState.selected) return;
  const filePath = explorerState.currentPath.replace(/\/$/, '') + '/' + explorerState.selected.name;
  showToast('Copiando…', 'info');
  const res = await api.containerCopyFile(explorerState.containerId, filePath, explorerState.desktop)
    .catch(e => ({ ok: false, error: e.message }));
  if (res.ok) {
    showToast(`✓ Copiado → ${res.dest}`, 'success');
  } else {
    showToast('✗ Error: ' + (res.error || 'desconocido'), 'error');
  }
}

function explorerOpenTerminal() {
  api.containerOpenTerminal(explorerState.containerId)
    .catch(() => {});
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js:'📄', ts:'📄', py:'🐍', sh:'📜', bash:'📜',
    json:'📋', yml:'📋', yaml:'📋', toml:'📋', env:'⚙',
    md:'📝', txt:'📝', log:'📋',
    png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼', svg:'🖼',
    mp4:'🎬', mp3:'🎵',
    zip:'📦', tar:'📦', gz:'📦', bz2:'📦',
    sql:'🗃', db:'🗃', sqlite:'🗃',
    html:'🌐', css:'🎨',
  };
  return map[ext] || '📄';
}

function humanFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return parseFloat(n.toFixed(1)) + ' ' + units[i];
}

// ─── Base de datos ─────────────────────────────────────────────────────────────

async function explorerDetectDb() {
  const id = explorerState.containerId;
  const badge = $id('db-type-badge');
  badge.className = 'db-badge';
  badge.textContent = 'Detectando...';
  $id('db-credentials-form').style.display = 'none';
  $id('db-list').innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-3)">Detectando...</div>';

  const res = await api.containerDetectDb(id).catch(e => ({ ok: false, error: e.message }));

  if (!res.ok) {
    badge.textContent = 'Error';
    $id('db-list').innerHTML = `<div style="padding:8px;font-size:12px;color:var(--red)">&#x2715; ${escHtml(res.error || 'Error desconocido')}</div>`;
    return;
  }

  if (!res.dbType) {
    badge.textContent = res.label || 'No detectada';
    const detail = res.detail ? `<br><span style="font-size:10px;color:var(--text-3)">${escHtml(res.detail)}</span>` : '';
    $id('db-list').innerHTML = `<div style="padding:8px;font-size:12px;color:var(--text-3)">Sin BD compatible${detail}</div>`;
    return;
  }

  explorerState.dbType  = res.dbType;
  explorerState.pgUser  = res.pgUser  || null;
  explorerState.pgPwd   = res.pgPwd   || null;
  explorerState.rootPwd = res.rootPwd || null;
  badge.className = 'db-badge ' + res.dbType;
  badge.textContent = res.label;

  // Si todas las estrategias automaticas fallaron -> mostrar formulario de credenciales
  if (res.needsCredentials) {
    const credForm = $id('db-credentials-form');
    credForm.style.display = 'block';
    $id('db-cred-user').value = res.pgUser || 'postgres';
    $id('db-cred-pwd').value  = '';
    $id('db-cred-status').textContent = res.detail || 'Introduce las credenciales para conectar';
    $id('db-list').innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-3)">Introduce las credenciales arriba y pulsa Conectar</div>';
    return;
  }

  await explorerLoadDbs();
}

// Verificar credenciales manuales
async function explorerVerifyCredentials() {
  const id     = explorerState.containerId;
  const dbType = explorerState.dbType;
  const user   = $id('db-cred-user').value.trim();
  const pwd    = $id('db-cred-pwd').value;
  const status = $id('db-cred-status');

  if (!user) { status.textContent = 'Introduce un usuario'; status.style.color = 'var(--red)'; return; }
  status.textContent = 'Verificando...';
  status.style.color = 'var(--text-3)';

  const r = await api.containerVerifyDbCredentials(id, dbType, user, pwd).catch(e => ({ ok: false, error: e.message }));
  if (r.ok) {
    explorerState.pgUser  = r.pgUser  || user;
    explorerState.pgPwd   = r.pgPwd   || pwd || null;
    explorerState.rootPwd = r.rootPwd || pwd || null;
    status.textContent = 'Conectado correctamente';
    status.style.color = 'var(--green)';
    $id('db-credentials-form').style.display = 'none';
    await explorerLoadDbs();
  } else {
    status.textContent = r.error || 'Credenciales incorrectas';
    status.style.color = 'var(--red)';
  }
}

async function explorerLoadDbs() {
  const id     = explorerState.containerId;
  const dbType = explorerState.dbType;
  if (!dbType) return;

  const listEl = $id('db-list');
  listEl.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-3)">Cargando...</div>';

  const res = await api.containerListDbs(id, dbType, explorerState.pgUser, explorerState.pgPwd, explorerState.rootPwd)
    .catch(e => ({ ok: false, error: e.message }));

  if (!res.ok) {
    listEl.innerHTML = `<div style="padding:8px;font-size:12px;color:var(--red)">&#x2715; ${escHtml(res.error)}</div>`;
    return;
  }

  listEl.innerHTML = '';
  (res.databases || []).forEach(db => {
    if (!db.trim()) return;
    const item = document.createElement('div');
    item.className = 'db-item';
    item.textContent = db;
    item.onclick = () => {
      document.querySelectorAll('#db-list .db-item').forEach(e => e.classList.remove('active'));
      item.classList.add('active');
      explorerState.currentDb = db;
      explorerLoadTables(db);
    };
    listEl.appendChild(item);
  });
  if (!listEl.children.length) {
    listEl.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-3)">Sin bases de datos</div>';
  }
}


// Ir a una BD especifica escrita manualmente
async function explorerSwitchToNamedDb() {
  const name = ($id('db-manual-name').value || '').trim();
  if (!name) { await explorerLoadDbs(); return; }
  // Simula seleccion de esa BD
  explorerState.currentDb = name;
  document.querySelectorAll('#db-list .db-item').forEach(e => e.classList.remove('active'));
  await explorerLoadTables(name);
  // Marcar visualmente si existe en la lista
  document.querySelectorAll('#db-list .db-item').forEach(el => {
    if (el.textContent.trim() === name) el.classList.add('active');
  });
}

async function explorerLoadTables(database) {
  const id     = explorerState.containerId;
  const dbType = explorerState.dbType;
  $id('db-tables-title').textContent = 'Tablas / Colecciones — ' + database;
  const tablesEl = $id('db-tables');
  tablesEl.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-3)">Cargando...</div>';

  const res = await api.containerListTables(id, dbType, database, explorerState.pgUser, explorerState.pgPwd, explorerState.rootPwd)
    .catch(e => ({ ok: false, error: e.message }));

  if (!res.ok) {
    tablesEl.innerHTML = `<div style="padding:8px;font-size:12px;color:var(--red)">&#x2715; ${escHtml(res.error)}</div>`;
    return;
  }

  tablesEl.innerHTML = '';
  (res.tables || []).forEach(t => {
    if (!t.trim()) return;
    const item = document.createElement('div');
    item.className = 'db-item';
    item.textContent = t;
    item.onclick = () => {
      document.querySelectorAll('#db-tables .db-item').forEach(e => e.classList.remove('active'));
      item.classList.add('active');
      const dt = explorerState.dbType;
      let sql = '';
      if (dt === 'postgres')       sql = `SELECT * FROM "${t}" LIMIT 20;`;
      else if (dt === 'mongodb')   sql = `db.${t}.find().limit(5).toArray()`;
      else if (dt === 'redis')     sql = `HGETALL ${t}`;
      else if (dt === 'sqlserver') sql = `SELECT TOP 20 * FROM [${t}];`;
      else                          sql = `SELECT * FROM \`${t}\` LIMIT 20;`;
      $id('db-query-input').value = sql;
    };
    tablesEl.appendChild(item);
  });
  if (!tablesEl.children.length) {
    tablesEl.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-3)">Sin tablas</div>';
  }
}

async function explorerRunQuery() {
  const id     = explorerState.containerId;
  const sql    = $id('db-query-input').value.trim();
  const db     = explorerState.currentDb;
  const dbType = explorerState.dbType;

  if (!sql) return;
  if (!db && dbType !== 'redis') { showToast('Selecciona una base de datos primero', 'info'); return; }

  const resultEl = $id('db-result');
  resultEl.textContent = 'Ejecutando...';

  const res = await api.containerQueryDb(id, dbType, db || '', sql, explorerState.pgUser, explorerState.pgPwd, explorerState.rootPwd)
    .catch(e => ({ ok: false, error: e.message }));

  resultEl.textContent = res.ok ? (res.output || '(sin salida)') : ('Error: ' + (res.error || 'desconocido'));
}

// ─── Renombrar contenedor ─────────────────────────────────────────────────────
function explorerShowRename() {
  const current = explorerState.containerName || '';
  const newName = prompt(`Nuevo nombre para el contenedor:\n(actual: ${current})`, current);
  if (!newName || newName.trim() === current) return;
  explorerDoRename(newName.trim());
}

async function explorerDoRename(newName) {
  const id = explorerState.containerId;
  const r = await api.containerRename(id, newName).catch(e => ({ ok: false, error: e.message }));
  if (r.ok) {
    explorerState.containerName = newName;
    $id('explorer-container-name').textContent = newName;
    showToast('Contenedor renombrado a: ' + newName, 'success');
    // Refrescar lista de contenedores en el fondo
    if (typeof loadContainers === 'function') setTimeout(loadContainers, 500);
  } else {
    showToast('Error al renombrar: ' + (r.error || 'desconocido'), 'error');
  }
}

// ─── Panel Red & Puertos ───────────────────────────────────────────────────────

async function explorerLoadNetworkInfo() {
  const id = explorerState.containerId;
  if (!id) return;

  const netEl = $id('net-networks-list');
  if (netEl) netEl.innerHTML = '<div class="net-placeholder">Cargando...</div>';

  const nr = await api.containerGetNetworkInfo(id).catch(() => ({ ok: false }));
  if (nr.ok && nr.networks && nr.networks.length) {
    netEl.innerHTML = nr.networks.map(n => `
      <div class="net-item">
        <span class="net-badge">${escHtml(n.name)}</span>
        <span class="net-ip">${escHtml(n.ip || '—')}</span>
        <span class="net-lbl" style="font-size:11px">GW: ${escHtml(n.gateway || '—')}</span>
        <span style="font-size:10px;color:var(--text-3);font-family:monospace">${escHtml(n.mac || '')}</span>
      </div>`).join('');
  } else if (netEl) {
    netEl.innerHTML = '<div class="net-placeholder">Sin informacion de red</div>';
  }

  const portEl = $id('net-ports-mapped');
  if (portEl) {
    if (nr.ok && nr.ports && nr.ports.length) {
      portEl.innerHTML = nr.ports.map(p => `
        <div class="net-item">
          <span class="net-badge host-port">${p.host ? escHtml(p.hostIp + ':' + p.host) : 'sin mapeo'}</span>
          <span style="color:var(--text-3);font-size:11px">&#x2192;</span>
          <span class="net-ip">${escHtml(p.container)}</span>
        </div>`).join('');
    } else {
      portEl.innerHTML = '<div class="net-placeholder">Sin puertos mapeados</div>';
    }
  }

  const lisEl = $id('net-ports-listen');
  if (lisEl) {
    lisEl.innerHTML = '<div class="net-placeholder">Consultando...</div>';
    const lr = await api.containerGetListeningPorts(id).catch(() => ({ ok: false }));
    if (lr.ok && lr.lines.length) {
      lisEl.innerHTML = lr.lines.slice(0, 30).map(l => `<div style="padding:2px 0">${escHtml(l)}</div>`).join('');
    } else {
      lisEl.innerHTML = `<div class="net-placeholder">${lr.ok ? 'Sin puertos en escucha' : 'No disponible (ss/netstat no encontrado)'}</div>`;
    }
  }

  const sel = $id('net-select-network');
  if (sel) {
    const dn = await api.containerListNetworks().catch(() => ({ ok: false }));
    if (dn.ok && dn.networks && dn.networks.length) {
      sel.innerHTML = dn.networks.filter(n => n.Name)
        .map(n => `<option value="${escHtml(n.Name)}">${escHtml(n.Name)} (${n.Driver || '?'})</option>`)
        .join('');
    } else {
      sel.innerHTML = '<option value="">Sin redes disponibles</option>';
    }
  }
}

function explorerRefreshNet() { explorerLoadNetworkInfo(); }

async function explorerNetConnect() {
  const id       = explorerState.containerId;
  const network  = $id('net-select-network').value;
  const staticIp = ($id('net-static-ip').value || '').trim() || null;
  if (!id || !network) return;
  const resEl = $id('net-action-result');
  resEl.textContent = 'Conectando...';
  resEl.style.color = 'var(--text-3)';
  const r = await api.containerNetworkAction(id, 'connect', network, staticIp).catch(e => ({ ok: false, error: e.message }));
  if (r.ok) {
    if (r.alreadyConnected) {
      resEl.textContent = 'Ya conectado a ' + network;
      resEl.style.color = 'var(--green)';
    } else {
      resEl.textContent = 'Conectado a ' + network + (staticIp ? ' (IP: ' + staticIp + ')' : '');
      resEl.style.color = 'var(--green)';
      setTimeout(explorerLoadNetworkInfo, 500);
    }
  } else {
    resEl.textContent = 'Error: ' + (r.error || 'desconocido');
    resEl.style.color = 'var(--red)';
  }
}

async function explorerNetDisconnect() {
  const id      = explorerState.containerId;
  const network = $id('net-select-network').value;
  if (!id || !network) return;
  const resEl = $id('net-action-result');
  resEl.textContent = 'Desconectando...';
  resEl.style.color = 'var(--text-3)';
  const r = await api.containerNetworkAction(id, 'disconnect', network, null).catch(e => ({ ok: false, error: e.message }));
  resEl.textContent = r.ok ? 'Desconectado de ' + network : 'Error: ' + (r.error || 'desconocido');
  resEl.style.color = r.ok ? 'var(--text-2)' : 'var(--red)';
  if (r.ok) setTimeout(explorerLoadNetworkInfo, 500);
}

// Arranque
document.addEventListener('DOMContentLoaded', init);
