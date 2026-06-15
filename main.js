// main.js — Proceso principal de Electron
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path    = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs    = require('fs');
const os    = require('os');
const https = require('https');

const execAsync = promisify(exec);
const IS_WIN    = os.platform() === 'win32';
const IS_MAC    = os.platform() === 'darwin';
const IS_DEV    = process.argv.includes('--dev');

// ══════════════════════════════════════════════════════════════════════════════
// SEGURIDAD — Helpers de validación y sanitización
// ══════════════════════════════════════════════════════════════════════════════

// Caracteres que no deben aparecer en parámetros de shell
const SHELL_INJECT_RE = /[;&|`$<>(){}!\\]/;
// Caracteres inválidos en rutas del sistema
const PATH_INVALID_RE = /[;&|`$<>{}!]/;

/**
 * Sanitiza una cadena de texto de inputs IPC.
 * Lanza error si excede maxLen o contiene caracteres de inyección de shell.
 */
function sanitizeArg(value, maxLen = 512, allowPath = false) {
  if (typeof value !== 'string') return '';
  if (value.length > maxLen) throw new Error(`Input demasiado largo (máx ${maxLen})`);
  const re = allowPath ? PATH_INVALID_RE : SHELL_INJECT_RE;
  if (re.test(value)) throw new Error(`Caracteres no permitidos en parámetro: ${value.slice(0,30)}`);
  return value.trim();
}

/** Valida que una acción Docker sea de la lista permitida */
const ALLOWED_CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart', 'remove', 'pause', 'unpause']);

/** Valida que un streamId sea solo alfanumérico + guiones */
function isValidStreamId(id) {
  return typeof id === 'string' && /^[\w\-]{1,64}$/.test(id);
}

/** Valida que un provider cloud sea de la lista permitida */
const ALLOWED_CLOUD_PROVIDERS = new Set(['azure', 'aws', 'dockerhub', 'huawei', 'vps']);

let mainWindow;
const activeStreams = new Map();
let remoteDockerHost = null;   // null = local, string = DOCKER_HOST remoto

// ── Docker PATH para Windows ──────────────────────────────────────────────────
const DOCKER_WIN_PATHS = [
  'C:\\Program Files\\Docker\\Docker\\resources\\bin',
  'C:\\Program Files\\Docker\\resources\\bin',
  'C:\\ProgramData\\DockerDesktop\\version-bin',
];

function buildDockerEnv() {
  const env = { ...process.env };
  if (IS_WIN) {
    const extra = DOCKER_WIN_PATHS.filter(p => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });
    if (extra.length) env.PATH = extra.join(';') + ';' + (env.PATH || '');
  }
  // Conexión remota: sobreescribir DOCKER_HOST si hay uno activo
  if (remoteDockerHost) env.DOCKER_HOST = remoteDockerHost;
  return env;
}

// ── dockerRun: spawn con array de args — sin shell, sin quoting problems ──────
function dockerRun(args, timeoutMs = 30000) {
  const env = buildDockerEnv();
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, { env, windowsHide: true });
    let out = '', err = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout (${timeoutMs / 1000}s) — Docker tardó demasiado`));
    }, timeoutMs);

    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out.trim());
      else reject(new Error(err.trim() || `docker salió con código ${code}`));
    });

    proc.on('error', e => {
      clearTimeout(timer);
      if (e.code === 'ENOENT')
        reject(new Error('docker no encontrado en PATH. ¿Está Docker Desktop instalado y corriendo?'));
      else
        reject(e);
    });
  });
}

// ── parseDockerOutput ─────────────────────────────────────────────────────────
function parseDockerOutput(output) {
  if (!output) return [];
  output = output.trim();
  if (output.startsWith('[')) {
    try { return JSON.parse(output); } catch {}
  }
  return output
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function parseLabels(raw) {
  const result = {};
  if (!raw) return result;
  raw.split(',').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq > -1) result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  });
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VENTANA PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1280,
    height:    820,
    minWidth:  960,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    title: 'Docker Manager',
    webPreferences: {
      preload:                    path.join(__dirname, 'preload.js'),
      contextIsolation:           true,
      nodeIntegration:            false,
      sandbox:                    true,        // proceso renderer aislado
      webSecurity:                true,        // bloquea mixed content y CORS forzado
      allowRunningInsecureContent:false,       // no HTTP en contexto HTTPS
      navigateOnDragDrop:         false,       // evita drag-drop de URLs externas
      devTools:                   IS_DEV,      // DevTools solo en modo desarrollo
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  Menu.setApplicationMenu(buildMenu());

  // DevTools solo en desarrollo — NUNCA en build de producción
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Bloquear navegación a URLs externas (previene ataques de redirección)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = `file://${path.join(__dirname, 'renderer', 'index.html')}`;
    if (!url.startsWith('file://') || url !== allowed) {
      event.preventDefault();
    }
  });

  // Abrir links externos en el navegador del sistema, no en Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    activeStreams.forEach(p => { try { p.kill(); } catch {} });
    mainWindow = null;
  });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Archivo',
      submenu: [
        { label: 'Recargar', accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload() },
        { type: 'separator' },
        { label: 'Salir', role: 'quit' },
      ],
    },
    {
      label: 'Vista',
      submenu: [
        // DevTools solo disponible en modo desarrollo
        ...(IS_DEV ? [{ label: 'DevTools', accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools() }] : []),
        { label: 'Zoom +', role: 'zoomIn' },
        { label: 'Zoom −', role: 'zoomOut' },
        { label: 'Tamaño normal', role: 'resetZoom' },
        { label: 'Pantalla completa', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Docs Docker', click: () => shell.openExternal('https://docs.docker.com') },
      ],
    },
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPC — DOCKER DATA
// ═══════════════════════════════════════════════════════════════════════════════

// ── Test conectividad ─────────────────────────────────────────────────────────
ipcMain.handle('docker:test', async () => {
  try {
    // --format con template sin espacios → sin quoting issues
    const ver = await dockerRun(['version', '--format', '{{.Client.Version}}'], 10000);
    return { ok: true, version: ver.trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Contenedores ──────────────────────────────────────────────────────────────
ipcMain.handle('docker:getContainers', async () => {
  try {
    const out = await dockerRun(['ps', '-a', '--format', '{{json .}}']);
    const containers = parseDockerOutput(out).map(c => {
      const labels = parseLabels(c.Labels || '');
      return {
        ...c,
        composeProject:  labels['com.docker.compose.project']             || '',
        composeService:  labels['com.docker.compose.service']             || '',
        composeWorkDir:  labels['com.docker.compose.project.working_dir'] || '',
      };
    });
    return { ok: true, data: containers };
  } catch (e) {
    return { ok: false, error: e.message, data: [] };
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
ipcMain.handle('docker:getStats', async () => {
  try {
    const out = await dockerRun(['stats', '--no-stream', '--format', '{{json .}}'], 60000);
    return { ok: true, data: parseDockerOutput(out) };
  } catch (e) {
    return { ok: false, error: e.message, data: [] };
  }
});

// ── Imágenes ──────────────────────────────────────────────────────────────────
ipcMain.handle('docker:getImages', async () => {
  try {
    const out = await dockerRun(['images', '--format', '{{json .}}']);
    return { ok: true, data: parseDockerOutput(out) };
  } catch (e) {
    return { ok: false, error: e.message, data: [] };
  }
});

// ── Volúmenes ─────────────────────────────────────────────────────────────────
ipcMain.handle('docker:getVolumes', async () => {
  try {
    const out = await dockerRun(['volume', 'ls', '--format', '{{json .}}']);
    return { ok: true, data: parseDockerOutput(out) };
  } catch (e) {
    return { ok: false, error: e.message, data: [] };
  }
});

// ── System df ─────────────────────────────────────────────────────────────────
ipcMain.handle('docker:getSystemDf', async () => {
  try {
    const out = await dockerRun(['system', 'df', '--format', '{{json .}}']);
    return { ok: true, data: parseDockerOutput(out) };
  } catch (e) {
    return { ok: false, error: e.message, data: [] };
  }
});

// ── Docker version info ────────────────────────────────────────────────────────
ipcMain.handle('docker:getInfo', async () => {
  try {
    const ver = await dockerRun(['version', '--format', '{{.Client.Version}}']);
    return { ok: true, data: { Client: { Version: ver.trim() } } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Proyectos compose ─────────────────────────────────────────────────────────
ipcMain.handle('docker:getProjects', async () => {
  try {
    const out = await dockerRun(['ps', '-a', '--format', '{{.Labels}}']);
    const projects = new Set();
    out.split('\n').forEach(line => {
      const labels = parseLabels(line);
      const proj   = labels['com.docker.compose.project'];
      if (proj) projects.add(proj);
    });
    return { ok: true, data: Array.from(projects).sort() };
  } catch (e) {
    return { ok: false, error: e.message, data: [] };
  }
});

// ── Acciones de contenedor ────────────────────────────────────────────────────
ipcMain.handle('docker:containerAction', async (_, { id, action }) => {
  try {
    // Validar action contra lista blanca
    if (!ALLOWED_CONTAINER_ACTIONS.has(action))
      return { ok: false, error: `Acción no permitida: ${action}` };
    // Validar ID del contenedor (solo hex + caracteres válidos de Docker)
    if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id || ''))
      return { ok: false, error: 'ID de contenedor inválido' };
    const args = action === 'remove' ? ['rm', '-f', id] : [action, id];
    await dockerRun(args, 60000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Logs (one-shot) ───────────────────────────────────────────────────────────
ipcMain.handle('docker:getLogs', async (_, { id, lines = 200 }) => {
  return new Promise(resolve => {
    const proc = spawn('docker', ['logs', '--tail', String(lines), '--timestamps', id],
      { env: buildDockerEnv(), windowsHide: true });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); }); // docker logs → stderr
    proc.on('close', () => resolve({ ok: true, data: out }));
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
});

// ── Prune ─────────────────────────────────────────────────────────────────────
ipcMain.handle('docker:pruneSystem', async (_, what) => {
  const cmdsMap = {
    images:     ['image',     'prune', '-f'],
    containers: ['container', 'prune', '-f'],
    volumes:    ['volume',    'prune', '-f'],
    all:        ['system',    'prune', '-f', '--volumes'],
  };
  if (!cmdsMap[what]) return { ok: false, error: 'Tipo inválido' };
  try {
    const out = await dockerRun(cmdsMap[what], 120000);
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:removeImage', async (_, id) => {
  try { await dockerRun(['rmi', '-f', id]); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('docker:removeVolume', async (_, name) => {
  try { await dockerRun(['volume', 'rm', name]); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── Conexión Docker remoto ─────────────────────────────────────────────────────
ipcMain.handle('docker:remoteConnect', async (_, { host }) => {
  const prev = remoteDockerHost;
  remoteDockerHost = host || null;
  try {
    const ver = await dockerRun(['version', '--format', '{{.Client.Version}}'], 8000);
    return { ok: true, version: ver.trim(), host: remoteDockerHost };
  } catch (e) {
    remoteDockerHost = prev; // revert
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:remoteDisconnect', () => {
  remoteDockerHost = null;
  return { ok: true };
});

ipcMain.handle('docker:remoteStatus', () => ({
  connected: !!remoteDockerHost,
  host: remoteDockerHost,
}));

// ── Transferencia por red (SCP) ────────────────────────────────────────────────
ipcMain.on('transfer:scp', (event, { bundlePath, host, user, remotePath, port = 22, streamId }) => {
  try {
    if (!isValidStreamId(streamId)) return;
    // Validar parámetros — evitar inyección en argumentos SCP
    const safeHost   = sanitizeArg(host, 253);
    const safeUser   = sanitizeArg(user, 64);
    const safePath   = sanitizeArg(remotePath, 512, true);
    const safeBundle = sanitizeArg(bundlePath, 1024, true);
    const safePort   = Math.max(1, Math.min(65535, parseInt(port, 10) || 22));

    if (!fs.existsSync(safeBundle))
      throw new Error(`Bundle no encontrado: ${safeBundle}`);

    const dest    = `${safeUser}@${safeHost}:${safePath}`;
    const scpArgs = ['-P', String(safePort),
      '-o', 'StrictHostKeyChecking=accept-new',   // más seguro que =no
      '-o', 'BatchMode=yes',
      safeBundle, dest];
    const proc = spawn('scp', scpArgs, { env: buildDockerEnv(), windowsHide: true });
    startStream(event, proc, streamId);
  } catch (e) {
    event.sender.send('stream:data', { streamId, data: `[ERROR SEGURIDAD] ${e.message}\n` });
    event.sender.send('stream:end',  { streamId, code: 1 });
  }
});

// ── Cloud: construir comandos de push ──────────────────────────────────────────
ipcMain.handle('cloud:getCommands', (_, { provider, image, registry, region, accountId, repo, username, password, hwAk, hwSk }) => {
  const destTag   = repo ? `${registry}/${repo}` : `${registry}/${image}`;
  const ecrReg    = accountId ? `${accountId}.dkr.ecr.${region}.amazonaws.com` : registry;
  const hwReg     = `swr.${region || 'la-south-2'}.myhuaweicloud.com`;

  const cmds = {
    azure: [
      `# Azure Container Registry — ${registry}`,
      `docker login ${registry} -u ${username || '<usuario>'} --password-stdin <<< "${password ? '****' : '<contraseña>'}"`,
      `# (o usa: az acr login --name ${registry.split('.')[0]})`,
      ``,
      `docker tag ${image} ${destTag}`,
      `docker push ${destTag}`,
    ],
    aws: [
      `# AWS ECR — región: ${region}`,
      `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${ecrReg}`,
      ``,
      `# Crear repo si no existe`,
      `aws ecr describe-repositories --repository-names ${repo || image.split(':')[0]} --region ${region} 2>/dev/null || aws ecr create-repository --repository-name ${repo || image.split(':')[0]} --region ${region}`,
      ``,
      `docker tag ${image} ${ecrReg}/${repo || image}`,
      `docker push ${ecrReg}/${repo || image}`,
    ],
    dockerhub: [
      `# Docker Hub — usuario: ${username || '<usuario>'}`,
      `docker login -u ${username || '<usuario>'} --password-stdin <<< "${password ? '****' : '<token>'}"`,
      ``,
      `docker tag ${image} ${username || '<usuario>'}/${repo || image}`,
      `docker push ${username || '<usuario>'}/${repo || image}`,
    ],
    huawei: [
      `# Huawei SWR — región: ${region}`,
      `# Genera tu token en: https://console.huaweicloud.com/swr → "Generar comando de login"`,
      `docker login -u ${region || '<region>'}@${hwAk || '<AK>'} -p <TOKEN_GENERADO> ${hwReg}`,
      ``,
      `docker tag ${image} ${hwReg}/${repo || image}`,
      `docker push ${hwReg}/${repo || image}`,
    ],
    vps: [
      `# VPS — Registry privado en ${registry}`,
      username
        ? `docker login ${registry} -u ${username} --password-stdin <<< "${password ? '****' : '<contraseña>'}"`
        : `# (registry sin autenticación)`,
      ``,
      `docker tag ${image} ${registry}/${repo || image}`,
      `docker push ${registry}/${repo || image}`,
    ],
  };
  return { ok: true, commands: (cmds[provider] || []).join('\n') };
});

// ── Ejecutar comando de cloud push ────────────────────────────────────────────
// PARCHE: validar que los comandos sean solo docker/az/aws/scp — previene inyección
const ALLOWED_CMD_PREFIXES = [
  'docker ', 'docker\n', '#',
  'az ', 'aws ', 'scp ', 'ssh ',
];

function isCloudCommandSafe(cmd) {
  if (typeof cmd !== 'string' || cmd.length > 8192) return false;
  const lines = cmd.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return lines.every(line =>
    ALLOWED_CMD_PREFIXES.some(pfx => line.startsWith(pfx))
  );
}

ipcMain.on('cloud:runCommand', (event, { command, streamId }) => {
  try {
    if (!isValidStreamId(streamId)) return;
    if (!isCloudCommandSafe(command)) {
      event.sender.send('stream:data', {
        streamId,
        data: '[SEGURIDAD] Comando rechazado: solo se permiten comandos docker/az/aws/scp.\n'
      });
      event.sender.send('stream:end', { streamId, code: 1 });
      return;
    }
    const sh   = IS_WIN ? 'cmd.exe' : '/bin/sh';
    const args = IS_WIN ? ['/c', command] : ['-c', command];
    const proc = spawn(sh, args, { env: buildDockerEnv(), windowsHide: true });
    startStream(event, proc, streamId);
  } catch (e) {
    event.sender.send('stream:data', { streamId, data: `[ERROR] ${e.message}\n` });
    event.sender.send('stream:end',  { streamId, code: 1 });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CLOUD REGISTRY — AUTH, EXPLORADOR, TAGS
// ══════════════════════════════════════════════════════════════════════════════

// Helper: HTTPS GET con timeout
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const req = https.get(url, { headers, timeout: 12000 }, (res) => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout de conexión (12s)')); });
    } catch (e) { reject(e); }
  });
}

// Obtiene Bearer token resolviendo el challenge WWW-Authenticate
async function getRegistryToken(registry, username, password, scope) {
  try {
    const b64 = Buffer.from(`${username}:${password}`).toString('base64');
    // Probe sin credenciales para obtener el challenge
    const probe = await httpsGet(`https://${registry}/v2/`, {
      'Authorization': `Basic ${b64}`
    });
    if (probe.status === 200) return null; // Basic auth directo funciona
    if (probe.status !== 401) return null;

    const wwwAuth = probe.headers['www-authenticate'] || '';
    if (!wwwAuth.toLowerCase().startsWith('bearer ')) return null;

    const realm   = (wwwAuth.match(/realm="([^"]+)"/i)   || [])[1];
    const service = (wwwAuth.match(/service="([^"]+)"/i) || [])[1] || registry;
    if (!realm) return null;

    const tokenUrl = `${realm}?service=${encodeURIComponent(service)}&scope=${encodeURIComponent(scope)}&account=${encodeURIComponent(username)}`;
    const tok = await httpsGet(tokenUrl, { 'Authorization': `Basic ${b64}` });
    if (tok.status !== 200) return null;
    const td = JSON.parse(tok.body);
    return td.token || td.access_token || null;
  } catch { return null; }
}

// docker login (CLI)
ipcMain.handle('cloud:dockerLogin', (_, { registry, username, password }) => {
  return new Promise(resolve => {
    const proc = spawn('docker', ['login', registry, '-u', username, '--password-stdin'],
      { env: buildDockerEnv(), windowsHide: true });
    let out = '', err = '';
    proc.stdin.write(password + '\n');
    proc.stdin.end();
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      const msg = (out + err).trim();
      const ok  = code === 0 || msg.toLowerCase().includes('login succeeded');
      resolve({ ok, message: msg, error: ok ? null : msg });
    });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
});

// Para AWS: obtener token ECR vía CLI de aws
ipcMain.handle('cloud:awsEcrLogin', (_, { region, accountId }) => {
  return new Promise(resolve => {
    const registry = `${accountId}.dkr.ecr.${region}.amazonaws.com`;
    const proc = spawn('aws', ['ecr', 'get-login-password', '--region', region],
      { env: buildDockerEnv(), windowsHide: true });
    let token = '', err = '';
    proc.stdout.on('data', d => { token += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      if (code !== 0 || !token.trim()) {
        resolve({ ok: false, error: err.trim() || 'aws CLI no encontrado o credenciales inválidas' });
        return;
      }
      resolve({ ok: true, registry, username: 'AWS', password: token.trim() });
    });
    proc.on('error', () => resolve({ ok: false, error: 'aws CLI no está instalado en este equipo' }));
  });
});

// Listar repositorios en el registry (Docker Registry API v2)
ipcMain.handle('cloud:listRepos', async (_, { registry, username, password }) => {
  try {
    const b64   = Buffer.from(`${username}:${password}`).toString('base64');
    const token = await getRegistryToken(registry, username, password, 'registry:catalog:*');
    const auth  = token ? `Bearer ${token}` : `Basic ${b64}`;

    const res = await httpsGet(`https://${registry}/v2/_catalog?n=300`, { 'Authorization': auth });
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      return { ok: true, repositories: data.repositories || [] };
    }
    return { ok: false, error: `HTTP ${res.status} — ${res.body.slice(0, 200)}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Listar tags de un repositorio
ipcMain.handle('cloud:listTags', async (_, { registry, username, password, repo }) => {
  try {
    const b64   = Buffer.from(`${username}:${password}`).toString('base64');
    const token = await getRegistryToken(registry, username, password, `repository:${repo}:pull`);
    const auth  = token ? `Bearer ${token}` : `Basic ${b64}`;

    const res = await httpsGet(`https://${registry}/v2/${repo}/tags/list`, { 'Authorization': auth });
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      return { ok: true, tags: (data.tags || []).sort() };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
});


// ── Find transfer scripts ──────────────────────────────────────────────────────

// ── Scan project for docker-compose services ──────────────────────────────────
ipcMain.handle('docker:scanProject', async (_, { projectPath }) => {
  try {
    const base = sanitizeArg(projectPath, 1024, true);
    if (!fs.existsSync(base)) return { ok: false, error: 'Directorio no encontrado' };

    // Find compose file
    const composeNames = [
      'docker-compose.yml','docker-compose.yaml',
      'compose.yml','compose.yaml',
    ];
    let composePath = null;
    for (const n of composeNames) {
      const p = path.join(base, n);
      if (fs.existsSync(p)) { composePath = p; break; }
    }

    let services = [];
    let composeContent = null;
    if (composePath) {
      try {
        const yaml = require('js-yaml');
        const raw  = fs.readFileSync(composePath, 'utf8');
        composeContent = raw;
        const doc  = yaml.load(raw);
        const svcs = doc?.services || {};
        services = Object.entries(svcs).map(([name, cfg]) => ({
          name,
          image:   cfg.image || `${path.basename(base)}-${name}`,
          volumes: (cfg.volumes || []).map(v => (typeof v === 'string' ? v : v.source || v.target || '')).filter(Boolean),
          ports:   (cfg.ports  || []).map(v => (typeof v === 'string' ? v : `${v.published||''}:${v.target||''}`)).filter(Boolean),
          buildsLocally: !!cfg.build,
        }));
      } catch (e) {
        return { ok: false, error: 'Error parseando compose: ' + e.message };
      }
    }

    // Get current Docker status for each service (match by compose project label)
    let dockerStatus = {};
    try {
      const psOut = await dockerRun(['ps','-a','--format','{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Labels}}']);
      psOut.split('\n').filter(Boolean).forEach(line => {
        const [cName, status, image, labels] = line.split('\t');
        const lblMap = {};
        (labels||'').split(',').forEach(l => { const [k,v]=l.split('='); if(k) lblMap[k.trim()]=v||''; });
        const svc = lblMap['com.docker.compose.service'];
        if (svc) dockerStatus[svc] = { containerName: cName, status, image, running: /^up/i.test(status||'') };
      });
    } catch {}

    // Merge Docker status into services
    services = services.map(s => ({
      ...s,
      containerName: dockerStatus[s.name]?.containerName || '',
      status:        dockerStatus[s.name]?.status || 'Not created',
      running:       dockerStatus[s.name]?.running || false,
    }));

    // Also detect named volumes declared at top level
    let topVolumes = [];
    try {
      const yaml = require('js-yaml');
      const doc = yaml.load(composeContent || '');
      topVolumes = Object.keys(doc?.volumes || {});
    } catch {}

    return { ok: true, composePath, services, topVolumes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Stop containers by name ───────────────────────────────────────────────────
ipcMain.handle('docker:stopByNames', async (_, { names }) => {
  if (!Array.isArray(names) || names.length === 0) return { ok: true };
  const safe = names.filter(n => /^[a-zA-Z0-9_.\-]{1,128}$/.test(n));
  if (safe.length !== names.length) return { ok: false, error: 'Nombre de contenedor inválido' };
  try {
    await dockerRun(['stop', ...safe], 60000);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Build bundle dynamically (streaming) ─────────────────────────────────────
// Generates a self-contained pack script and runs it streaming
ipcMain.on('docker:buildBundle', (event, { projectPath, outputDir, services, options, streamId }) => {
  if (!isValidStreamId(streamId)) return;
  const send = data => {
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:data', { streamId, data }); } catch {}
  };
  const done = code => {
    activeStreams.delete(streamId);
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code }); } catch {}
  };

  (async () => {
    try {
      const base    = sanitizeArg(projectPath, 1024, true);
      const outBase = outputDir ? sanitizeArg(outputDir, 1024, true) : path.join(base, 'bundles');
      if (!fs.existsSync(outBase)) fs.mkdirSync(outBase, { recursive: true });

      const stamp    = new Date().toISOString().slice(0,16).replace(/[T:]/g,'-');
      const projName = path.basename(base).replace(/[^a-z0-9_\-]/gi,'') || 'project';
      const bundleDir = path.join(outBase, `${projName}-bundle-${stamp}`);
      fs.mkdirSync(bundleDir, { recursive: true });
      const imagesDir = path.join(bundleDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });

      send(`\n📦 Creando bundle: ${bundleDir}\n\n`);

      // 1. Save images
      for (const svc of services) {
        if (!svc.image) continue;
        send(`  🐳 Guardando imagen: ${svc.image}…\n`);
        const safeName = svc.image.replace(/[^a-z0-9.\-_]/gi,'_');
        const outFile  = path.join(imagesDir, `${safeName}.tar`);
        await new Promise((res, rej) => {
          const p = spawn('docker', ['save', '-o', outFile, svc.image],
            { env: buildDockerEnv(), windowsHide: true });
          p.stdout.on('data', d => send(d.toString()));
          p.stderr.on('data', d => send(d.toString()));
          p.on('close', code => code === 0 ? res() : rej(new Error(`docker save falló (código ${code})`)));
          p.on('error', rej);
          activeStreams.set(streamId, p);
        });
        send(`  ✓ ${path.basename(outFile)}\n`);
      }

      // 2. Backup named volumes (skip if --skip-volumes)
      if (!options?.skipVolumes) {
        const vols = [...new Set(services.flatMap(s => s.volumes||[])
          .map(v => v.split(':')[0])
          .filter(v => v && !v.startsWith('/') && !v.startsWith('.') && !v.match(/^[A-Za-z]:[\\/]/)))];
        if (vols.length) {
          const volDir = path.join(bundleDir, 'volumes');
          fs.mkdirSync(volDir, { recursive: true });
          for (const vol of vols) {
            send(`  💾 Respaldando volumen: ${vol}…\n`);
            const outFile = path.join(volDir, `${vol}.tar.gz`);
            await new Promise((res, rej) => {
              // Use docker run with busybox to create volume backup
              const p = spawn('docker', [
                'run','--rm','-v', `${vol}:/backup_src:ro`,
                '-v', `${volDir}:/backup_dst`,
                'busybox','sh','-c',
                `tar czf /backup_dst/${vol}.tar.gz -C / backup_src 2>&1`
              ], { env: buildDockerEnv(), windowsHide: true });
              p.stdout.on('data', d => send(d.toString()));
              p.stderr.on('data', d => send(d.toString()));
              p.on('close', code => {
                if (code === 0) res();
                else { send(`  ⚠ Volumen ${vol} no se pudo respaldar (puede estar vacío o no existir)\n`); res(); }
              });
              p.on('error', e => { send(`  ⚠ ${e.message}\n`); res(); });
              activeStreams.set(streamId, p);
            });
          }
        }
      }

      // 3. Copy compose file
      const composeNames = ['docker-compose.yml','docker-compose.yaml','compose.yml','compose.yaml'];
      for (const n of composeNames) {
        const src = path.join(base, n);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(bundleDir, n));
          send(`  📋 Copiando ${n}\n`);
          break;
        }
      }

      // 4. Copy .env if exists
      const envFile = path.join(base, '.env');
      if (fs.existsSync(envFile)) {
        fs.copyFileSync(envFile, path.join(bundleDir, '.env'));
        send(`  📋 Copiando .env\n`);
      }

      // 5. Generate deploy script
      const serviceList = services.map(s => s.image || s.name).join(' ');
      const deployShContent = `#!/bin/bash
# Auto-generated deploy script — ${projName} ${stamp}
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=\${1:-3000}
echo "=== Deploy ${projName} ==="

# Load images
for f in "$SCRIPT_DIR/images"/*.tar; do
  [ -f "$f" ] || continue
  echo "Importando: $f"
  docker load -i "$f"
done

# Restore volumes
if [ -d "$SCRIPT_DIR/volumes" ]; then
  for f in "$SCRIPT_DIR/volumes"/*.tar.gz; do
    [ -f "$f" ] || continue
    VOL=\$(basename "$f" .tar.gz)
    echo "Restaurando volumen: $VOL"
    docker volume create "$VOL" 2>/dev/null || true
    docker run --rm -v "$VOL":/restore -v "$SCRIPT_DIR/volumes":/src busybox \\
      sh -c "cd /restore && tar xzf /src/$VOL.tar.gz --strip-components=1" || true
  done
fi

# Start stack
cd "$SCRIPT_DIR"
[ -f docker-compose.yml ] || { echo "No docker-compose.yml found"; exit 1; }
export PORT=$PORT
docker compose up -d
echo "=== ✓ Desplegado en puerto $PORT ===
`;
      fs.writeFileSync(path.join(bundleDir, 'deploy.sh'), deployShContent, { mode: 0o755 });

      const deployPs1Content = `# Auto-generated deploy script — ${projName} ${stamp}
param([int]$Port = 3000)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "=== Deploy ${projName} ==="

# Load images
Get-ChildItem "$ScriptDir\\images\\*.tar" | ForEach-Object {
  Write-Host "Importando: $_"; docker load -i $_
}

# Restore volumes
if (Test-Path "$ScriptDir\\volumes") {
  Get-ChildItem "$ScriptDir\\volumes\\*.tar.gz" | ForEach-Object {
    $vol = $_.BaseName -replace '\\.tar$',''
    Write-Host "Restaurando volumen: $vol"
    docker volume create $vol 2>$null
    docker run --rm -v "${vol}:/restore" -v "$ScriptDir\\volumes:/src" busybox sh -c "cd /restore && tar xzf /src/${vol}.tar.gz --strip-components=1"
  }
}

Set-Location $ScriptDir
$env:PORT = $Port
docker compose up -d
Write-Host "=== ✓ Desplegado en puerto $Port ==="
`;
      fs.writeFileSync(path.join(bundleDir, 'deploy.ps1'), deployPs1Content);
      send(`  📜 Script deploy.sh / deploy.ps1 generado\n`);

      // 6. Create final tar.gz
      send(`\n📁 Comprimiendo bundle…\n`);
      const finalBundle = path.join(outBase, `${projName}-bundle-${stamp}.tar.gz`);
      await new Promise((res, rej) => {
        const p = spawn('tar', ['czf', finalBundle, '-C', outBase, `${projName}-bundle-${stamp}`],
          { windowsHide: true });
        p.stderr.on('data', d => send(d.toString()));
        p.on('close', code => code === 0 ? res() : rej(new Error(`tar falló (código ${code})`)));
        p.on('error', rej);
        activeStreams.set(streamId, p);
      });

      // Remove temp dir
      try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch {}

      const size = (() => {
        try { const bytes = fs.statSync(finalBundle).size; return bytes > 1e9 ? (bytes/1e9).toFixed(2)+'GB' : bytes > 1e6 ? (bytes/1e6).toFixed(1)+'MB' : Math.round(bytes/1024)+'KB'; } catch { return '?'; }
      })();
      send(`\n✅ Bundle listo: ${finalBundle}\n   Tamaño: ${size}\n`);
      event.sender.send('stream:end', { streamId, code: 0, filePath: finalBundle });
    } catch (e) {
      send(`\n❌ Error: ${e.message}\n`);
      done(1);
    }
  })();
});


// ── Docker Compose actions (streaming) ───────────────────────────────────────
ipcMain.on('docker:composeAction', (event, { projectDir, action, services, build, streamId }) => {
  if (!isValidStreamId(streamId)) return;
  const send = data => {
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:data', { streamId, data }); } catch {}
  };
  const done = code => {
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code }); } catch {}
  };

  try {
    const safeDir = sanitizeArg(projectDir || '', 1024, true);
    if (!safeDir || !fs.existsSync(safeDir)) {
      send('Error: Directorio del proyecto no encontrado: ' + safeDir + '\n');
      done(1); return;
    }

    // Build docker compose args
    const composeArgs = ['compose'];
    if (action === 'up') {
      composeArgs.push('up', '-d');
      if (build) composeArgs.push('--build');
      if (Array.isArray(services) && services.length) composeArgs.push(...services.map(s => sanitizeArg(s, 128)));
    } else if (action === 'down') {
      composeArgs.push('down');
      if (Array.isArray(services) && services.length) {
        // 'down' doesn't accept service names, use 'stop' instead
        composeArgs.splice(1, 1, 'stop');
        composeArgs.push(...services.map(s => sanitizeArg(s, 128)));
      }
    } else if (action === 'restart') {
      composeArgs.push('restart');
      if (Array.isArray(services) && services.length) composeArgs.push(...services.map(s => sanitizeArg(s, 128)));
    } else if (action === 'stop') {
      composeArgs.push('stop');
      if (Array.isArray(services) && services.length) composeArgs.push(...services.map(s => sanitizeArg(s, 128)));
    } else if (action === 'pull') {
      composeArgs.push('pull');
    } else if (action === 'logs') {
      composeArgs.push('logs', '--tail=100');
      if (Array.isArray(services) && services.length) composeArgs.push(...services.map(s => sanitizeArg(s, 128)));
    } else {
      send('Acción no válida: ' + action + '\n'); done(1); return;
    }

    send('▶ docker ' + composeArgs.join(' ') + '\n   Directorio: ' + safeDir + '\n\n');

    const proc = spawn('docker', composeArgs, {
      env: buildDockerEnv(),
      cwd: safeDir,
      windowsHide: true,
    });
    activeStreams.set(streamId, proc);

    proc.stdout.on('data', d => send(d.toString()));
    proc.stderr.on('data', d => send(d.toString()));
    proc.on('close', code => {
      activeStreams.delete(streamId);
      done(code);
    });
    proc.on('error', e => {
      activeStreams.delete(streamId);
      send('\nError: ' + e.message + '\n');
      done(1);
    });
  } catch (e) {
    send('Error: ' + e.message + '\n');
    done(1);
  }
});

// ── Get compose project info for a container ──────────────────────────────────
ipcMain.handle('docker:getComposeInfo', async (_, { containerId }) => {
  try {
    const safe = sanitizeArg(containerId, 128);
    if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(safe)) return { ok: false, error: 'ID inválido' };
    const out = await dockerRun(['inspect', '--format', '{{json .Config.Labels}}', safe]);
    const labels = JSON.parse(out.trim() || '{}');
    return {
      ok: true,
      project:    labels['com.docker.compose.project']             || '',
      service:    labels['com.docker.compose.service']             || '',
      workDir:    labels['com.docker.compose.project.working_dir'] || '',
      configFile: labels['com.docker.compose.project.config_files']|| '',
    };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('docker:findTransferScripts', async (_, startPath) => {
  const ALLOWED_EXT = new Set(['.sh', '.ps1', '.bat', '.cmd']);
  const results = [];
  const scan = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full, depth + 1);
      else if (e.isFile() && ALLOWED_EXT.has(path.extname(e.name).toLowerCase())) {
        results.push(full);
      }
    }
  };
  try {
    const base = startPath ? sanitizeArg(startPath, 1024, true) : os.homedir();
    scan(base, 0);
    return { ok: true, scripts: results.slice(0, 200) };
  } catch (e) { return { ok: false, error: e.message, scripts: [] }; }
});

// ── Run script as stream ───────────────────────────────────────────────────────
ipcMain.on('docker:runScript', (event, { scriptPath, args = [], streamId, cwd }) => {
  if (!isValidStreamId(streamId)) return;
  const ALLOWED_EXT = ['.sh', '.ps1', '.bat', '.cmd'];
  try {
    const safePath = sanitizeArg(scriptPath, 1024, true);
    if (!ALLOWED_EXT.includes(path.extname(safePath).toLowerCase()))
      throw new Error('Extensión de script no permitida');
    if (!fs.existsSync(safePath)) throw new Error('Script no encontrado');
    if (!Array.isArray(args) || args.length > 20)
      throw new Error('Argumentos inválidos');
    const safeArgs = args.map(a => sanitizeArg(String(a), 256));
    const ext = path.extname(safePath).toLowerCase();
    let cmd, cmdArgs;
    if (IS_WIN && (ext === '.bat' || ext === '.cmd')) {
      cmd = 'cmd.exe'; cmdArgs = ['/c', safePath, ...safeArgs];
    } else if (IS_WIN && ext === '.ps1') {
      cmd = 'powershell.exe';
      cmdArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', safePath, ...safeArgs];
    } else {
      cmd = 'bash'; cmdArgs = [safePath, ...safeArgs];
    }
    const opts = { env: buildDockerEnv(), windowsHide: true };
    if (cwd && fs.existsSync(cwd)) opts.cwd = cwd;
    const proc = spawn(cmd, cmdArgs, opts);
    activeStreams.set(streamId, proc);
    const send = data => {
      try { if (!event.sender.isDestroyed()) event.sender.send('stream:data', { streamId, data }); } catch {}
    };
    proc.stdout.on('data', d => send(d.toString()));
    proc.stderr.on('data', d => send(d.toString()));
    proc.on('close', code => {
      activeStreams.delete(streamId);
      try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code }); } catch {}
    });
    proc.on('error', e => {
      activeStreams.delete(streamId);
      send(`\nError: ${e.message}\n`);
      try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    });
  } catch (e) {
    try { event.sender.send('stream:data', { streamId, data: `Error: ${e.message}\n` }); } catch {}
    try { event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
  }
});

// ── Kill stream ────────────────────────────────────────────────────────────────
ipcMain.on('stream:kill', (_, { streamId }) => {
  if (!isValidStreamId(streamId)) return;
  const proc = activeStreams.get(streamId);
  if (proc) { try { proc.kill(); } catch {} activeStreams.delete(streamId); }
});

// ── Docker log streaming ───────────────────────────────────────────────────────
ipcMain.on('docker:streamLogs', (event, { id, streamId }) => {
  if (!isValidStreamId(streamId)) return;
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return;
  const proc = spawn('docker',
    ['logs', '--follow', '--timestamps', '--tail', '200', id],
    { env: buildDockerEnv(), windowsHide: true });
  activeStreams.set(streamId, proc);
  const send = data => {
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:data', { streamId, data }); } catch {}
  };
  proc.stdout.on('data', d => send(d.toString()));
  proc.stderr.on('data', d => send(d.toString()));
  proc.on('close', code => {
    activeStreams.delete(streamId);
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code }); } catch {}
  });
  proc.on('error', e => {
    activeStreams.delete(streamId);
    send(`Error: ${e.message}\n`);
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
  });
});

// ── Diálogos ──────────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async (_, options = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    ...options,
  });
  if (canceled || !filePaths.length) return null;
  return options.properties?.includes('multiSelections') ? filePaths : filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_, options = {}) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, options);
  return canceled ? null : filePath;
});

// ── Sistema de archivos ────────────────────────────────────────────────────────
ipcMain.handle('shell:openPath', (_, filePath) => shell.openPath(filePath));

ipcMain.handle('fs:exists', (_, filePath) => {
  try { return fs.existsSync(filePath); } catch { return false; }
});

ipcMain.handle('fs:readDir', (_, dirPath) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
      path: path.join(dirPath, e.name),
    }));
  } catch { return []; }
});

// ── Utilidades ────────────────────────────────────────────────────────────────
ipcMain.handle('util:platform', () => os.platform());

// ── Versión y dependencias ────────────────────────────────────────────────────
const APP_ROOT = __dirname;

ipcMain.handle('app:getVersion', () => ({
  ok:         true,
  appVersion: app.getVersion(),
  electron:   process.versions.electron,
  node:       process.versions.node,
  chrome:     process.versions.chrome,
  platform:   os.platform() + ' ' + os.release(),
}));

ipcMain.handle('app:checkUpdates', () => {
  return new Promise(resolve => {
    const proc = spawn('npm', ['outdated', '--json', '--prefix', APP_ROOT],
      { env: process.env, windowsHide: true, shell: IS_WIN });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      try {
        const data = JSON.parse(out || '{}');
        const packages = Object.entries(data).map(([name, v]) => ({
          name, current: v.current, wanted: v.wanted, latest: v.latest,
          isOutdated: v.current !== v.latest,
        }));
        resolve({ ok: true, packages });
      } catch { resolve({ ok: true, packages: [] }); }
    });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
});

ipcMain.handle('app:updatePackage', (_, { name, version = 'latest' }) => {
  if (!name || !/^[@a-z0-9\-_\/]{1,200}$/i.test(name))
    return { ok: false, error: 'Nombre de paquete inválido' };
  // Validar versión: semver, 'latest', 'next', 'beta', o rango semver básico
  const safeVersion = (typeof version === 'string' && /^[a-z0-9\.\-\^~\*]{1,50}$/i.test(version))
    ? version : 'latest';
  return new Promise(resolve => {
    const target = `${name}@${safeVersion}`;
    const proc = spawn('npm', ['install', '--prefix', APP_ROOT, target, '--save-dev'],
      { env: process.env, windowsHide: true, shell: IS_WIN });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => resolve({
      ok: code === 0,
      message: (out + err).trim().slice(0, 500),
      error:   code !== 0 ? err.slice(0, 300) : null
    }));
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
});

ipcMain.handle('app:auditDeps', () => {
  return new Promise(resolve => {
    const proc = spawn('npm', ['audit', '--json', '--prefix', APP_ROOT],
      { env: process.env, windowsHide: true, shell: IS_WIN });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      try {
        const data = JSON.parse(out || '{}');
        const meta  = data.metadata?.vulnerabilities || {};
        const total = meta.total ?? (meta.info + meta.low + meta.moderate + meta.high + meta.critical) ?? 0;
        resolve({ ok: true, total, high: (meta.high || 0) + (meta.critical || 0), meta });
      } catch { resolve({ ok: true, total: 0, high: 0, meta: {} }); }
    });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WSL — Windows Subsystem for Linux
// ═══════════════════════════════════════════════════════════════════════════════

function isValidDistroName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_.\- ]{1,100}$/.test(name.trim());
}

function wslRun(args, timeoutMs = 30000) {
  return new Promise(resolve => {
    if (!IS_WIN) { resolve({ rc: -1, stdout: '', stderr: 'Solo disponible en Windows' }); return; }
    const proc = spawn('wsl.exe', args, { windowsHide: true });
    let outBufs = [], errBufs = [];
    proc.stdout.on('data', d => outBufs.push(d));
    proc.stderr.on('data', d => errBufs.push(d));
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.on('close', rc => {
      clearTimeout(timer);
      const dec = (bufs, isShellCmd) => {
        if (!bufs.length) return '';
        const buf = Buffer.concat(bufs);
        // Shell commands inside WSL output UTF-8; wsl.exe system commands output UTF-16LE
        if (isShellCmd) return buf.toString('utf8').replace(/\r/g, '');
        // Detect UTF-16LE: every odd byte should be 0x00 for ASCII-heavy content
        let nullOdds = 0;
        const check = Math.min(buf.length - 1, 30);
        for (let i = 1; i < check; i += 2) { if (buf[i] === 0) nullOdds++; }
        const isUtf16 = check > 2 && nullOdds > check / 4;
        if (isUtf16) return buf.toString('utf16le').replace(/\uFEFF/g, '').replace(/\r/g, '');
        return buf.toString('utf8').replace(/\r/g, '');
      };
      const isShell = args[0] === '-d' || args[0] === '--exec';
      resolve({ rc, stdout: dec(outBufs, isShell), stderr: dec(errBufs, isShell) });
    });
    proc.on('error', e => { clearTimeout(timer); resolve({ rc: -1, stdout: '', stderr: e.message }); });
  });
}

function psRun(script, timeoutMs = 15000) {
  return new Promise(resolve => {
    if (!IS_WIN) { resolve({ rc: -1, stdout: '', stderr: 'Solo disponible en Windows' }); return; }
    const proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.stderr.on('data', d => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.on('close', rc => { clearTimeout(timer); resolve({ rc, stdout: out.trim(), stderr: err.trim() }); });
    proc.on('error', e => { clearTimeout(timer); resolve({ rc: -1, stdout: '', stderr: e.message }); });
  });
}

function humanizeBytes(n) {
  if (!n || n <= 0) return '?';
  const units = ['B','KB','MB','GB','TB']; let i = 0, f = n;
  while (f >= 1024 && i < units.length - 1) { f /= 1024; i++; }
  return parseFloat(f.toFixed(2)) + ' ' + units[i];
}

ipcMain.handle('wsl:list', async () => {
  if (!IS_WIN) return { ok: false, error: 'Solo disponible en Windows', distros: [] };
  try {
    const { stdout: runOut } = await wslRun(['--list', '--running', '--quiet'], 10000);
    const running = new Set(runOut.split(/\r?\n/).map(l => l.trim()).filter(Boolean));

    const psScript = [
      "$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'",
      "try { $def = (Get-ItemProperty $root -EA Stop).DefaultDistribution } catch { $def = '' }",
      "$arr = @()",
      "Get-ChildItem $root -EA SilentlyContinue | ForEach-Object {",
      "  $name = $_.GetValue('DistributionName')",
      "  if (-not $name) { return }",
      "  $base = ($_.GetValue('BasePath') -replace '^\\\\\\\\\?\\\\','')",
      "  $ver  = [string]$_.GetValue('Version')",
      "  $guid = $_.PSChildName",
      "  $vhdx = [IO.Path]::Combine($base,'ext4.vhdx')",
      "  $size = 0",
      "  try { $size = (Get-Item -LiteralPath $vhdx -Force -EA Stop).Length } catch {}",
      "  $arr += [PSCustomObject]@{Name=$name;BasePath=$base;Version=$ver;Guid=$guid;Size=$size;IsDefault=($guid -eq $def)}",
      "}",
      "if ($arr.Count -gt 0) { $arr | ConvertTo-Json -Compress } else { '[]' }",
    ].join('\n');

    const { stdout: psOut } = await psRun(psScript, 20000);
    let reg = [];
    try { reg = JSON.parse(psOut || '[]'); if (!Array.isArray(reg)) reg = [reg]; } catch {}

    const distros = reg
      .filter(d => d && d.Name)
      .map(d => ({
        name:      d.Name,
        state:     running.has(d.Name) ? 'Running' : 'Stopped',
        version:   d.Version || '?',
        isDefault: !!d.IsDefault,
        path:      d.BasePath || '',
        sizeBytes: d.Size || 0,
        size:      humanizeBytes(d.Size),
      }))
      .sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name));

    return { ok: true, distros };
  } catch (e) { return { ok: false, error: e.message, distros: [] }; }
});

const ALLOWED_WSL_ACTIONS = new Set(['terminate','setDefault','unregister','shutdown','update','status','start','restart']);

ipcMain.handle('wsl:action', async (_, { action, distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo disponible en Windows' };
  if (!ALLOWED_WSL_ACTIONS.has(action)) return { ok: false, error: 'Accion no permitida' };
  if (!['shutdown','update','status'].includes(action) && !isValidDistroName(distro))
    return { ok: false, error: 'Nombre de distro invalido' };
  const argsMap = {
    terminate:  ['--terminate', distro],
    start:      ['-d', distro, '--', 'sh', '-c', 'true'],
    restart:    null,
    setDefault: ['--set-default', distro],
    unregister: ['--unregister', distro],
    shutdown:   ['--shutdown'],
    update:     ['--update'],
    status:     ['--status'],
  };
  // restart = terminate then start
  if (action === 'restart') {
    const { rc: r1 } = await wslRun(['--terminate', distro], 15000);
    await new Promise(res => setTimeout(res, 800));
    const { rc: r2, stdout, stderr } = await wslRun(['-d', distro, '--', 'sh', '-c', 'true'], 15000);
    return { ok: r2 === 0, output: r1 === 0 && r2 === 0 ? 'Reiniciado correctamente' : (stdout + '\n' + stderr).trim() };
  }
  const tmo = action === 'update' ? 900000 : 60000;
  const { rc, stdout, stderr } = await wslRun(argsMap[action], tmo);
  return { ok: rc === 0, output: (stdout + '\n' + stderr).trim() };
});

ipcMain.handle('wsl:setVersion', async (_, { distro, version }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  if (!['1','2'].includes(String(version))) return { ok: false, error: 'Version invalida' };
  const { rc, stdout, stderr } = await wslRun(['--set-version', distro, String(version)], 1800000);
  return { ok: rc === 0, output: (stdout + '\n' + stderr).trim() };
});

ipcMain.handle('wsl:getResources', async (_, { distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  const run = cmd => wslRun(['-d', distro, '--', 'bash', '-c', cmd], 20000).then(r => r.stdout);
  const [df, mem, ps, ports] = await Promise.all([
    run('df -hT 2>/dev/null'),
    run('free -h 2>/dev/null'),
    run("ps -eo pid,pcpu,pmem,comm --sort=-pmem 2>/dev/null | head -n 12"),
    run("ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null | head -20"),
  ]);
  return { ok: true, df, mem, ps, ports };
});

ipcMain.handle('wsl:sshStatus', async (_, { distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  const run = cmd => wslRun(['-d', distro, '--', 'bash', '-c', 'LANG=C LC_ALL=C ' + cmd], 10000).then(r => r.stdout.trim());
  const [installed, running, port, user, ip] = await Promise.all([
    run("command -v sshd >/dev/null 2>&1 && echo YES || echo NO"),
    run("pgrep -x sshd >/dev/null 2>&1 && echo YES || echo NO"),
    run("grep -E '^Port ' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -n1"),
    run("whoami"),
    run("hostname -I 2>/dev/null | awk '{print $1}'"),
  ]);
  return { ok: true, installed: installed.includes('YES'), running: running.includes('YES'),
    port: port || '22', user: user || 'root', ip: ip || '(no detectada)' };
});

ipcMain.handle('wsl:getMounts', async (_, { distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  const { rc, stdout, stderr } = await wslRun(['-d', distro, '--', 'bash', '-c',
    "findmnt -ln -o SOURCE,TARGET,FSTYPE,OPTIONS 2>/dev/null || mount"], 15000);
  if (rc !== 0) return { ok: false, error: stderr };
  const rows = stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const p = line.split(/\s+/, 4);
    return { source: p[0]||'', target: p[1]||'', fstype: p[2]||'', options: p[3]||'' };
  });
  return { ok: true, rows };
});

ipcMain.handle('wsl:openExplorer', async (_, { distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  const r = await shell.openPath('\\\\wsl.localhost\\' + distro + '\\');
  if (!r) return { ok: true };
  const r2 = await shell.openPath('\\\\wsl$\\' + distro + '\\');
  return { ok: !r2, error: r2 || undefined };
});

ipcMain.handle('wsl:openTerminal', async (_, { distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  try {
    const { spawnSync } = require('child_process');
    const wt = spawnSync('where', ['wt.exe'], { windowsHide: true, shell: true });
    if (wt.status === 0) {
      spawn('wt.exe', ['wsl.exe', '-d', distro], { detached: true, windowsHide: false });
    } else {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'wsl.exe -d "' + distro + '"'],
        { detached: true, shell: true, windowsHide: true });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

const ALLOWED_WSL_TERMINAL_SCRIPTS = {
  'ssh:install:deb': 'sudo apt update && sudo apt install -y openssh-server && sudo ssh-keygen -A',
  'ssh:install:rpm': 'sudo dnf install -y openssh-server && sudo ssh-keygen -A',
  'ssh:install:pac': 'sudo pacman -Sy --noconfirm openssh && sudo ssh-keygen -A',
  'ssh:install:zpp': 'sudo zypper -n install openssh && sudo ssh-keygen -A',
  'ssh:regen':       'sudo rm -f /etc/ssh/ssh_host_* && sudo ssh-keygen -A',
  'upgrade:deb':     'sudo apt update && sudo apt -y full-upgrade && sudo apt -y autoremove',
  'upgrade:rpm':     'sudo dnf -y upgrade --refresh',
  'upgrade:pac':     'sudo pacman -Syu --noconfirm',
  'upgrade:zpp':     'sudo zypper -n refresh && sudo zypper -n update',
};

ipcMain.handle('wsl:openTerminalScript', async (_, { distro, scriptKey }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  const cmd = ALLOWED_WSL_TERMINAL_SCRIPTS[scriptKey];
  if (!cmd) return { ok: false, error: 'Script no permitido: ' + scriptKey };
  const line = 'wsl.exe -d "' + distro + '" -- bash -lc "' + cmd + '; echo; echo --- Hecho. Pulsa Enter ---; read"';
  spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', line],
    { detached: true, shell: true, windowsHide: true });
  return { ok: true };
});

const ALLOWED_WSL_PRESETS = {
  'ssh:start':        'for s in sshd ssh; do pgrep -x $s >/dev/null && echo "[OK] $s ya en ejecucion" && exit 0; done; for s in sshd ssh; do [ -f /etc/init.d/$s ] && /etc/init.d/$s start 2>&1 && exit 0; systemctl start $s 2>/dev/null && exit 0; service $s start 2>/dev/null && exit 0; done; /usr/sbin/sshd 2>/dev/null && echo "[OK] sshd iniciado" || echo "[ERROR] No se pudo iniciar SSH — instala openssh-server primero"',
  'ssh:stop':         'for s in sshd ssh; do [ -f /etc/init.d/$s ] && /etc/init.d/$s stop 2>&1 && exit 0; systemctl stop $s 2>/dev/null && exit 0; service $s stop 2>/dev/null && exit 0; done; pkill -x sshd && echo "[OK] sshd detenido" || echo "[WARN] sshd no estaba en ejecucion"',
  'ssh:restart':      'for s in sshd ssh; do [ -f /etc/init.d/$s ] && /etc/init.d/$s restart 2>&1 && exit 0; systemctl restart $s 2>/dev/null && exit 0; service $s restart 2>/dev/null && exit 0; done; pkill -x sshd; sleep 1; /usr/sbin/sshd 2>/dev/null && echo "[OK] sshd reiniciado" || echo "[ERROR] No se pudo reiniciar SSH"',
  'ssh:status':       'pgrep -x sshd >/dev/null && echo "[RUNNING] sshd activo" || echo "[STOPPED] sshd no en ejecucion"; ss -tlnp 2>/dev/null | head -10 || netstat -tlnp 2>/dev/null | head -10',
  'ssh:regen':        'rm -f /etc/ssh/ssh_host_* && ssh-keygen -A && echo "[OK] Claves SSH regeneradas"',
  'ssh:enableBoot':   "grep -q '[boot]' /etc/wsl.conf 2>/dev/null || printf '[boot]\\ncommand=\"for s in sshd ssh; do /usr/sbin/sshd 2>/dev/null || true; done\"\\n' | tee -a /etc/wsl.conf; echo '--- /etc/wsl.conf ---'; cat /etc/wsl.conf",
  'ssh:install:deb':  'DEBIAN_FRONTEND=noninteractive apt-get update -y 2>&1 | tail -3 && apt-get install -y openssh-server 2>&1 | tail -5 && ssh-keygen -A && echo "[OK] openssh-server instalado"',
  'ssh:install:rpm':  'dnf install -y openssh-server 2>&1 | tail -5 && ssh-keygen -A && echo "[OK] openssh-server instalado"',
  'ssh:install:pac':  'pacman -Sy --noconfirm openssh 2>&1 | tail -5 && ssh-keygen -A && echo "[OK] openssh instalado"',
  'ssh:install:zpp':  'zypper -n install openssh 2>&1 | tail -5 && ssh-keygen -A && echo "[OK] openssh instalado"',
  'pkg:update:deb':   'DEBIAN_FRONTEND=noninteractive apt-get update -y && apt-get upgrade -y',
  'pkg:update:rpm':   'dnf update -y',
  'pkg:update:pac':   'pacman -Syu --noconfirm',
  'pkg:update:zpp':   'zypper -n update',
  'wsl:ports':        'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "instala iproute2 para ver puertos"',
  // Tool auto-install presets
  'tool:sshpass:deb':  'DEBIAN_FRONTEND=noninteractive apt-get install -y sshpass 2>&1 && echo "[OK] sshpass instalado"',
  'tool:sshpass:rpm':  'dnf install -y sshpass 2>&1 || yum install -y sshpass 2>&1 && echo "[OK] sshpass instalado"',
  'tool:sshpass:pac':  'pacman -Sy --noconfirm sshpass 2>&1 && echo "[OK] sshpass instalado"',
  'tool:sshpass:zpp':  'zypper -n install sshpass 2>&1 && echo "[OK] sshpass instalado"',
  'tool:iproute2:deb': 'DEBIAN_FRONTEND=noninteractive apt-get install -y iproute2 2>&1 && echo "[OK] iproute2 instalado"',
  'tool:iproute2:rpm': 'dnf install -y iproute 2>&1 && echo "[OK] iproute instalado"',
  'tool:iproute2:pac': 'pacman -Sy --noconfirm iproute2 2>&1 && echo "[OK] iproute2 instalado"',
  'tool:iproute2:zpp': 'zypper -n install iproute2 2>&1 && echo "[OK] iproute2 instalado"',
};

ipcMain.handle('wsl:openVhdxDir', async (_, opts) => {
  if (!IS_WIN) return { ok: false };
  const { shell } = require('electron');
  const localApp = process.env.LOCALAPPDATA || '';
  // If caller passes the distro's basePath, open that directory directly
  if (opts && opts.distroPath) {
    try {
      const dir = opts.distroPath.replace(/^\\\\\?\\/, ''); // strip \?\ prefix
      shell.openPath(dir);
      return { ok: true, path: dir };
    } catch {}
  }
  // Otherwise try known WSL2 storage locations
  const candidates = [
    path.join(localApp, 'wsl'),           // Windows 11 new WSL storage
    path.join(localApp, 'lxss'),          // WSL1 / legacy
    path.join(localApp, 'Packages'),      // older WSL2 (per-package subdirs)
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) { shell.openPath(c); return { ok: true, path: c }; } } catch {}
  }
  shell.openPath(localApp);
  return { ok: true, path: localApp };
});

ipcMain.handle('wsl:openFolder', async (_, { folderPath }) => {
  try {
    const { shell } = require('electron');
    const dir = path.dirname(folderPath);
    shell.openPath(dir);
    return { ok: true };
  } catch { return { ok: false }; }
});

ipcMain.on('wsl:streamPreset', (event, { distro, preset, streamId }) => {
  if (!IS_WIN || !isValidStreamId(streamId) || !isValidDistroName(distro)) {
    try { event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    return;
  }
  const cmd = ALLOWED_WSL_PRESETS[preset];
  if (!cmd) {
    try { event.sender.send('stream:data', { streamId, data: 'Preset no permitido\n' }); } catch {}
    try { event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    return;
  }
  const proc = spawn('wsl.exe', ['-d', distro, '-u', 'root', '--', 'bash', '-c', cmd],
    { windowsHide: true });
  activeStreams.set(streamId, proc);
  const send = data => {
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:data', { streamId, data }); } catch {}
  };
  proc.stdout.on('data', d => send(d.toString('utf8')));
  proc.stderr.on('data', d => send(d.toString('utf8')));
  proc.on('close', code => {
    activeStreams.delete(streamId);
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code }); } catch {}
  });
  proc.on('error', e => {
    activeStreams.delete(streamId);
    send('Error: ' + e.message + '\n');
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
  });
});

ipcMain.on('wsl:streamBindMount', (event, { distro, winPath, mountPoint, streamId }) => {
  if (!IS_WIN || !isValidStreamId(streamId) || !isValidDistroName(distro)) {
    try { event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    return;
  }
  if (!/^\/[a-zA-Z0-9_.\-\/]{1,200}$/.test((mountPoint||'').trim())) {
    try { event.sender.send('stream:data', { streamId, data: 'Punto de montaje invalido\n' }); } catch {}
    try { event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    return;
  }
  const mp = mountPoint.trim();
  wslRun(['--exec', 'wslpath', '-u', winPath], 5000).then(unixRes => {
    let unixSrc = unixRes.stdout.trim();
    if (!unixSrc) {
      const p = winPath.replace(/\\/g, '/');
      const m = p.match(/^([A-Za-z]):\/(.*)/);
      unixSrc = m ? '/mnt/' + m[1].toLowerCase() + '/' + m[2] : p;
    }
    const safe   = unixSrc.replace(/'/g, "'\\''");
    const safeMp = mp.replace(/'/g, "'\\''");
    const cmd    = "sudo mkdir -p '" + safeMp + "' && sudo mount --bind '" + safe + "' '" + safeMp + "' && echo OK && findmnt '" + safeMp + "'";
    const proc   = spawn('wsl.exe', ['-d', distro, '-u', 'root', '--', 'bash', '-c', cmd],
      { windowsHide: true });
    activeStreams.set(streamId, proc);
    const send = data => {
      try { if (!event.sender.isDestroyed()) event.sender.send('stream:data', { streamId, data }); } catch {}
    };
    proc.stdout.on('data', d => send(d.toString('utf8')));
    proc.stderr.on('data', d => send(d.toString('utf8')));
    proc.on('close', code => {
      activeStreams.delete(streamId);
      try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code }); } catch {}
    });
    proc.on('error', e => {
      activeStreams.delete(streamId);
      send('Error: ' + e.message + '\n');
      try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    });
  });
});

ipcMain.on('wsl:streamTransfer', (event, { distro, winPaths, destPath, streamId }) => {
  if (!IS_WIN || !isValidStreamId(streamId) || !isValidDistroName(distro)) {
    try { event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    return;
  }
  if (!destPath || !/^\/[a-zA-Z0-9_.\-\/~]{1,200}$/.test(destPath.trim())) {
    try { event.sender.send('stream:data', { streamId, data: 'Ruta destino invalida\n' }); } catch {}
    try { event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    return;
  }
  if (!Array.isArray(winPaths) || winPaths.length === 0) {
    try { event.sender.send('stream:data', { streamId, data: 'Sin archivos seleccionados\n' }); } catch {}
    try { event.sender.send('stream:end', { streamId, code: -1 }); } catch {}
    return;
  }
  const validPaths = winPaths.filter(p => typeof p === 'string' && p.length < 1024 && fs.existsSync(p));
  const send = data => {
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:data', { streamId, data }); } catch {}
  };
  const dst = destPath.trim();
  (async () => {
    send('Creando destino ' + dst + '...\n');
    await wslRun(['-d', distro, '-u', 'root', '--', 'bash', '-c',
      "mkdir -p '" + dst.replace(/'/g, "'\\''") + "'"], 10000);
    let ok = 0, fail = 0;
    for (const winPath of validPaths) {
      const unixRes = await wslRun(['--exec', 'wslpath', '-u', winPath], 5000);
      let unixPath = unixRes.stdout.trim();
      if (!unixPath) {
        const p = winPath.replace(/\\/g, '/');
        const m = p.match(/^([A-Za-z]):\/(.*)/);
        unixPath = m ? '/mnt/' + m[1].toLowerCase() + '/' + m[2] : p;
      }
      const safeSrc = unixPath.replace(/'/g, "'\\''");
      const safeDst = dst.replace(/'/g, "'\\''");
      const cpRes   = await wslRun(['-d', distro, '-u', 'root', '--', 'bash', '-c',
        "cp -av '" + safeSrc + "' '" + safeDst + "/'"], 300000);
      if (cpRes.rc === 0) { ok++;   send('[OK]  ' + winPath + '\n'); }
      else                { fail++; send('[ERR] ' + winPath + ': ' + (cpRes.stderr.trim() || cpRes.stdout.trim()) + '\n'); }
    }
    send('\n=== Transferencia finalizada: ' + ok + ' OK, ' + fail + ' errores ===\n');
    try { if (!event.sender.isDestroyed()) event.sender.send('stream:end', { streamId, code: fail > 0 ? 1 : 0 }); } catch {}
  })();
});

ipcMain.handle('wsl:getFileSize', async (_, { filePath }) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false };
  try {
    const stat = fs.statSync(filePath);
    const bytes = stat.size;
    const units = ['B','KB','MB','GB','TB']; let i = 0, f = bytes;
    while (f >= 1024 && i < units.length - 1) { f /= 1024; i++; }
    return { ok: true, size: parseFloat(f.toFixed(2)) + ' ' + units[i], bytes };
  } catch { return { ok: false, size: '—' }; }
});

ipcMain.handle('wsl:exportPick', async (_, { distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  const date = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Guardar exportación de '" + distro + "'",
    defaultPath: distro.replace(/[^a-zA-Z0-9_.\-]/g, '_') + '_' + date + '.tar',
    filters: [
      { name: 'TAR (recomendado)', extensions: ['tar'] },
      { name: 'VHDX', extensions: ['vhdx'] },
    ],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };
  return { ok: true, filePath };
});

ipcMain.handle('wsl:exportRun', async (_, { distro, filePath, streamId }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'Ruta invalida' };
  if (!isValidStreamId(streamId)) return { ok: false, error: 'StreamId invalido' };

  const sendWins = (ev, payload) => {
    try { require('electron').BrowserWindow.getAllWindows()
      .filter(w => !w.isDestroyed()).forEach(w => w.webContents.send(ev, payload)); } catch {}
  };
  const send = data => sendWins('stream:data', { streamId, data });

  // Run wsl --export and stream progress messages since wsl.exe doesn't output during export
  send(`[Exportando '${distro}' → ${filePath}]\n`);
  const args = ['--export', distro, filePath];
  if (filePath.toLowerCase().endsWith('.vhdx')) args.push('--vhd');

  const wslExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'wsl.exe') : 'wsl.exe';
  const proc = spawn(wslExe, args, { windowsHide: true });
  activeStreams.set(streamId, proc);

  // wsl --export doesn't write to stdout; emit a progress ticker
  let dots = 0;
  const ticker = setInterval(() => { send('.'); dots++; if (dots % 60 === 0) send('\n'); }, 1000);

  proc.stdout.on('data', d => send(d.toString('utf8')));
  proc.stderr.on('data', d => send(d.toString('utf8')));
  proc.on('error', err => {
    clearInterval(ticker);
    send('\n[Error: ' + err.message + ']\n');
    activeStreams.delete(streamId);
    sendWins('stream:end', { streamId, code: -1, filePath: null });
  });
  proc.on('close', code => {
    clearInterval(ticker);
    activeStreams.delete(streamId);
    const ok = code === 0;
    send('\n' + (ok ? '[OK] Exportación completada.' : '[ERROR] Falló (código ' + code + ')') + '\n');
    // Pass filePath back so renderer can show the result modal
    sendWins('stream:end', { streamId, code, filePath: ok ? filePath : null });
  });
  return { ok: true };
});

// Keep exportDialog as an alias for legacy compatibility
ipcMain.handle('wsl:exportDialog', async (_, { distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  const pick = await ipcMain.listeners('wsl:exportPick') ? null : null; // handled inline:
  const date = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Exportar '" + distro + "'",
    defaultPath: distro.replace(/[^a-zA-Z0-9_.\-]/g, '_') + '_' + date + '.tar',
    filters: [{ name: 'TAR', extensions: ['tar'] }, { name: 'VHDX', extensions: ['vhdx'] }],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };
  const args = ['--export', distro, filePath];
  if (filePath.toLowerCase().endsWith('.vhdx')) args.push('--vhd');
  const { rc, stdout, stderr } = await wslRun(args, 7200000);
  return { ok: rc === 0, output: (stdout + '\n' + stderr).trim(), filePath };
});

ipcMain.handle('wsl:exportToNetwork', async (_, { distro, destPath }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  // destPath must be a UNC path or absolute Windows path — validate basic structure
  if (!destPath || typeof destPath !== 'string' || destPath.length > 512)
    return { ok: false, error: 'Ruta de destino invalida' };
  // Basic path sanity: must start with \\\\ (UNC) or drive letter
  const _destOk = destPath.startsWith('\\\\') || /^[A-Za-z]:[\\\\/]/.test(destPath);
  if (!_destOk) return { ok: false, error: 'Ruta invalida: usa \\\\servidor\\carpeta o C:\\ruta' };
  try { fs.mkdirSync(destPath, { recursive: true }); } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, error: 'No se pudo crear destino: ' + e.message };
  }
  const date = new Date().toISOString().slice(0, 10);
  const fileName = distro.replace(/[^a-zA-Z0-9_.\-]/g, '_') + '_' + date + '.tar';
  const fullPath = path.join(destPath, fileName);
  const { rc, stdout, stderr } = await wslRun(['--export', distro, fullPath], 7200000);
  return { ok: rc === 0, output: (stdout + '\n' + stderr).trim(), filePath: fullPath };
});

ipcMain.handle('wsl:importDialog', async () => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona .tar o .vhdx',
    filters: [{ name: 'TAR / VHDX', extensions: ['tar','vhdx'] }, { name: 'Todos', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, cancelled: true };
  return { ok: true, filePath: filePaths[0] };
});

ipcMain.handle('wsl:import', async (_, { name, installDir, srcPath }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(name)) return { ok: false, error: 'Nombre invalido' };
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'Archivo no encontrado' };
  if (!installDir || typeof installDir !== 'string') return { ok: false, error: 'Directorio invalido' };
  try { fs.mkdirSync(installDir, { recursive: true }); } catch {}
  const args = ['--import', name, installDir, srcPath];
  if (srcPath.toLowerCase().endsWith('.vhdx')) args.push('--vhd');
  const { rc, stdout, stderr } = await wslRun(args, 7200000);
  return { ok: rc === 0, output: (stdout + '\n' + stderr).trim() };
});

ipcMain.handle('wsl:listDisks', async () => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows', disks: [] };
  const { rc, stdout } = await psRun(
    "Get-CimInstance Win32_DiskDrive | Select-Object DeviceID,Model,@{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}} | ConvertTo-Json -Compress",
    10000);
  if (rc !== 0) return { ok: true, disks: [] };
  try {
    let data = JSON.parse(stdout || '[]');
    if (!Array.isArray(data)) data = [data];
    return { ok: true, disks: data };
  } catch { return { ok: true, disks: [] }; }
});

ipcMain.handle('wsl:sshChangePort', async (_, { distro, port }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) return { ok: false, error: 'Puerto invalido' };
  const cmd = "sudo sed -i -E 's|^#?Port .*|Port " + p + "|' /etc/ssh/sshd_config && grep -E '^Port' /etc/ssh/sshd_config";
  const { rc, stdout, stderr } = await wslRun(['-d', distro, '-u', 'root', '--', 'bash', '-c', cmd], 15000);
  return { ok: rc === 0, output: (stdout + '\n' + stderr).trim() };
});

// ─── Terminal Shell / SSH ─────────────────────────────────────────────────────
// Opens a WSL shell or external SSH connection and streams PTY data
// stdin is kept open so the renderer can send keystrokes via stream:stdin

ipcMain.handle('wsl:openShell', async (_, { distro, streamId }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  if (!isValidStreamId(streamId)) return { ok: false, error: 'StreamId invalido' };

  // Full path to wsl.exe avoids PATH issues in spawned processes
  const wslExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'wsl.exe')
    : 'wsl.exe';

  // --exec runs the binary directly (no --  separator that some WSL versions forward to bash)
  // -i: forces line-buffered stdout even when stdin/stdout are pipes
  const proc = spawn(wslExe, ['-d', distro, '--exec', 'bash', '-i'],
    { windowsHide: true });

  activeStreams.set(streamId, proc);

  const sendWins = (event, payload) => {
    try {
      require('electron').BrowserWindow.getAllWindows()
        .forEach(w => { if (!w.isDestroyed()) w.webContents.send(event, payload); });
    } catch {}
  };
  const send = data => sendWins('stream:data', { streamId, data });

  proc.stdout.on('data', d => send(d.toString('utf8')));
  proc.stderr.on('data', d => send(d.toString('utf8')));
  proc.on('error', err => {
    send('\r\n[Error al iniciar shell: ' + err.message + ']\r\n');
    activeStreams.delete(streamId);
    sendWins('stream:end', { streamId, code: -1 });
  });
  proc.on('close', code => {
    activeStreams.delete(streamId);
    sendWins('stream:end', { streamId, code });
  });

  return { ok: true };
});

ipcMain.handle('wsl:sshConnect', async (_, { host, port, user, password, streamId, gatewayDistro }) => {
  if (!isValidStreamId(streamId)) return { ok: false, error: 'StreamId invalido' };
  if (!host || !/^[a-zA-Z0-9._\-]{1,253}$/.test(host)) return { ok: false, error: 'Host invalido' };
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) return { ok: false, error: 'Puerto invalido' };
  if (!user || user.length > 64) return { ok: false, error: 'Usuario invalido' };

  let proc;
  // On Windows: route SSH through WSL for proper PTY and stdin/stdout piping
  if (IS_WIN && gatewayDistro && isValidDistroName(gatewayDistro)) {
    const wslExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'wsl.exe')
      : 'wsl.exe';
    // Use sshpass if available, otherwise inject password via stdin
    const sshArgs = `-tt -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${p} ${user}@${host}`;
    const sshCmd = password
      ? `if command -v sshpass >/dev/null 2>&1; then sshpass -p ${JSON.stringify(password)} ssh ${sshArgs}; else ssh -o BatchMode=no ${sshArgs}; fi`
      : `ssh ${sshArgs}`;
    proc = spawn(wslExe, ['-d', gatewayDistro, '--', 'bash', '-c', sshCmd],
      { windowsHide: true });
    if (password) {
      // Fallback: send password via stdin if sshpass not available
      setTimeout(() => {
        try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(password + '\n'); } catch {}
      }, 2500);
    }
  } else {
    // Linux/macOS or no gateway: use system ssh directly
    const sshBin = IS_WIN
      ? (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe') : 'ssh.exe')
      : 'ssh';
    const args = ['-tt', '-p', String(p),
                  '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15',
                  '-o', 'BatchMode=no', user + '@' + host];
    proc = spawn(sshBin, args, { windowsHide: true });
    if (password) {
      setTimeout(() => {
        try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(password + '\n'); } catch {}
      }, 2000);
    }
  }
  activeStreams.set(streamId, proc);

  const send = (data) => {
    try {
      const wins = require('electron').BrowserWindow.getAllWindows();
      wins.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('stream:data', { streamId, data });
      });
    } catch {}
  };

  proc.stdout.on('data', d => send(d.toString('utf8')));
  proc.stderr.on('data', d => send(d.toString('utf8')));
  proc.on('close', code => {
    activeStreams.delete(streamId);
    try {
      const wins = require('electron').BrowserWindow.getAllWindows();
      wins.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('stream:end', { streamId, code });
      });
    } catch {}
  });
  proc.on('error', err => {
    send('[Error al iniciar SSH: ' + err.message + ']\n');
    activeStreams.delete(streamId);
  });

  return { ok: true };
});

// Send keystrokes / stdin data to an active stream process
ipcMain.on('stream:stdin', (_, { streamId, data }) => {
  const proc = activeStreams.get(streamId);
  if (proc && proc.stdin && !proc.stdin.destroyed) {
    try { proc.stdin.write(data); } catch {}
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// REMOTE WSL — Gestión de máquinas WSL en equipos Windows remotos vía SSH
// ═══════════════════════════════════════════════════════════════════════════════

// Run a command on a remote Windows host via SSH (routed through a local WSL distro)
async function remoteSSHCmd({ gatewayDistro, host, port, user, password }, cmd, timeoutMs = 30000) {
  if (!IS_WIN) return { rc: -1, stdout: '', stderr: 'Solo Windows' };
  const wslExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'wsl.exe')
    : 'wsl.exe';
  const sshArgs = `-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=no -p ${port}`;
  const escapedCmd = cmd.replace(/'/g, "'\''");
  let shellCmd;
  if (password) {
    const escapedPwd = JSON.stringify(password);
    shellCmd = `if command -v sshpass >/dev/null 2>&1; then sshpass -p ${escapedPwd} ssh ${sshArgs} ${user}@${host} '${escapedCmd}'; else echo "NEEDS_KEY_AUTH"; fi`;
  } else {
    shellCmd = `ssh ${sshArgs} ${user}@${host} '${escapedCmd}'`;
  }
  const wslArgs = ['-d', gatewayDistro, '--', 'bash', '-c', shellCmd];
  const { rc, stdout, stderr } = await new Promise(resolve => {
    const proc = spawn(wslExe, wslArgs, { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.stderr.on('data', d => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.on('close', rc => { clearTimeout(timer); resolve({ rc, stdout: out.trim(), stderr: err.trim() }); });
    proc.on('error', e => { clearTimeout(timer); resolve({ rc: -1, stdout: '', stderr: e.message }); });
  });
  return { rc, stdout, stderr };
}

// Parse `wsl.exe --list --verbose` output (UTF-16 LE on Windows, but through SSH it's UTF-8)
function parseRemoteWslList(raw) {
  const distros = [];
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i].trim();
    if (!line) continue;
    const isDefault = line.startsWith('*');
    const clean = line.replace(/^\*\s*/, '').trim();
    const parts = clean.split(/\s+/);
    if (parts.length >= 2) {
      distros.push({
        name:      parts[0],
        state:     parts[1] || 'Unknown',
        version:   parts[2] || '?',
        isDefault: isDefault,
      });
    }
  }
  return distros;
}

ipcMain.handle('wsl:remoteList', async (_, { host, port, user, password, gatewayDistro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(gatewayDistro)) return { ok: false, error: 'Gateway invalido' };
  const p = parseInt(port, 10) || 22;
  const creds = { gatewayDistro, host, port: p, user, password };
  // Try to list WSL distros on the remote machine via PowerShell + wsl.exe
  const { rc, stdout, stderr } = await remoteSSHCmd(creds,
    'powershell.exe -NonInteractive -Command "& wsl.exe --list --verbose"',
    20000);
  if (stdout.includes('NEEDS_KEY_AUTH'))
    return { ok: false, error: 'sshpass no disponible en WSL. Usa autenticación por clave SSH.' };
  if (rc !== 0 && !stdout)
    return { ok: false, error: (stderr || 'No se pudo listar distros remotas') };
  const distros = parseRemoteWslList(stdout);
  return { ok: true, distros, raw: stdout };
});

ipcMain.handle('wsl:remoteAction', async (_, { host, port, user, password, gatewayDistro, distro, action }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(gatewayDistro)) return { ok: false, error: 'Gateway invalido' };
  if (!isValidDistroName(distro) && !['shutdown'].includes(action)) return { ok: false, error: 'Distro invalida' };
  const p = parseInt(port, 10) || 22;
  const creds = { gatewayDistro, host, port: p, user, password };
  const cmdMap = {
    start:     `wsl.exe -d ${distro} -- sh -c true`,
    terminate: `wsl.exe --terminate ${distro}`,
    shutdown:  'wsl.exe --shutdown',
    restart:   `wsl.exe --terminate ${distro} & wsl.exe -d ${distro} -- sh -c true`,
  };
  const cmd = cmdMap[action];
  if (!cmd) return { ok: false, error: 'Accion no permitida' };
  const { rc, stdout, stderr } = await remoteSSHCmd(creds, cmd, 60000);
  return { ok: rc === 0, output: (stdout + '\n' + stderr).trim() };
});

ipcMain.handle('wsl:remoteResources', async (_, { host, port, user, password, gatewayDistro, distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(gatewayDistro)) return { ok: false, error: 'Gateway invalido' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Distro invalida' };
  const p = parseInt(port, 10) || 22;
  const creds = { gatewayDistro, host, port: p, user, password };
  // Use cmd.exe-safe syntax on remote Windows:
  // - '&' as command separator (NOT ';' which is bash-only)
  // - Separate wsl.exe invocations avoid compound bash-c escaping
  // - No '2>/dev/null' (cmd.exe interprets '>' as file redirect even inside quotes)
  // - Use PowerShell to avoid cmd.exe redirect issues entirely
  const sep = '~~~WSL_SEP~~~';
  const psCmd = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `wsl.exe -d ${distro} -- free -h`,
    `Write-Output '${sep}DF${sep}'`,
    `wsl.exe -d ${distro} -- df -hT`,
    `Write-Output '${sep}PS${sep}'`,
    `wsl.exe -d ${distro} -- ps -eo pid,pcpu,pmem,comm`,
    `Write-Output '${sep}PORTS${sep}'`,
    `wsl.exe -d ${distro} -- ss -tlnp`,
    `if ($LASTEXITCODE -ne 0) { wsl.exe -d ${distro} -- netstat -tlnp }`,
  ].join('; ');
  const cmd = `powershell.exe -NonInteractive -Command "${psCmd}"`;
  const { rc, stdout } = await remoteSSHCmd(creds, cmd, 45000);
  if (!stdout) return { ok: false, error: 'Sin respuesta del equipo remoto (verifica que WSL y la distro estén activos)' };
  const sepRx = new RegExp(`~~~WSL_SEP~~~(?:DF|PS|PORTS)~~~WSL_SEP~~~`);
  const parts = stdout.split(/~~~WSL_SEP~~~(?:DF|PS|PORTS)~~~WSL_SEP~~~/);
  return { ok: true, mem: (parts[0]||'').trim(), df: (parts[1]||'').trim(),
           ps: (parts[2]||'').trim(), ports: (parts[3]||'').trim() };
});

// Streaming: SSH to remote Windows → wsl.exe -d distro bash -i
ipcMain.handle('wsl:remoteShell', async (_, { host, port, user, password, gatewayDistro, distro, streamId }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidStreamId(streamId)) return { ok: false, error: 'StreamId invalido' };
  if (!isValidDistroName(gatewayDistro)) return { ok: false, error: 'Gateway invalido' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Distro invalida' };
  const wslExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'wsl.exe')
    : 'wsl.exe';
  const p = parseInt(port, 10) || 22;
  const sshArgs = `-tt -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${p}`;
  const remoteCmd = `wsl.exe -d ${distro} -- bash -i 2>&1`;
  let shellCmd;
  if (password) {
    const esc = JSON.stringify(password);
    shellCmd = `if command -v sshpass >/dev/null 2>&1; then sshpass -p ${esc} ssh ${sshArgs} ${user}@${host} '${remoteCmd}'; else ssh -o BatchMode=no ${sshArgs} ${user}@${host} '${remoteCmd}'; fi`;
  } else {
    shellCmd = `ssh ${sshArgs} ${user}@${host} '${remoteCmd}'`;
  }
  const proc = spawn(wslExe, ['-d', gatewayDistro, '--', 'bash', '-c', shellCmd],
    { windowsHide: true });
  activeStreams.set(streamId, proc);
  const sendWins = (ev, payload) => {
    try { require('electron').BrowserWindow.getAllWindows()
      .filter(w => !w.isDestroyed()).forEach(w => w.webContents.send(ev, payload)); } catch {}
  };
  if (password) {
    setTimeout(() => {
      try { if (!proc.stdin.destroyed) proc.stdin.write(password + '\n'); } catch {}
    }, 2500);
  }
  proc.stdout.on('data', d => sendWins('stream:data', { streamId, data: d.toString('utf8') }));
  proc.stderr.on('data', d => sendWins('stream:data', { streamId, data: d.toString('utf8') }));
  proc.on('error', err => {
    sendWins('stream:data', { streamId, data: '\r\n[Error: ' + err.message + ']\r\n' });
    activeStreams.delete(streamId);
    sendWins('stream:end', { streamId, code: -1 });
  });
  proc.on('close', code => {
    activeStreams.delete(streamId);
    sendWins('stream:end', { streamId, code });
  });
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPLORADOR DE CONTENEDORES — listado, copia, escritorio
// ═══════════════════════════════════════════════════════════════════════════════

function parseLsOutput(raw) {
  const entries = [];
  raw.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('total')) return;
    const m = line.match(/^([dl\-][rwxst\-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.*)/);
    if (!m) return;
    const [, perms, size, name] = m;
    if (name === '.' || name === '..') return;
    const isDir  = perms[0] === 'd';
    const isLink = perms[0] === 'l';
    const realName = isLink ? name.split(' -> ')[0].trim() : name;
    entries.push({ name: realName, isDir, isLink, size: parseInt(size, 10) || 0, perms });
  });
  return entries;
}

ipcMain.handle('container:listDir', async (_, { id, dirPath }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id))
    return { ok: false, error: 'ID de contenedor inválido' };
  if (!dirPath || !dirPath.startsWith('/') || SHELL_INJECT_RE.test(dirPath))
    return { ok: false, error: 'Ruta inválida' };
  if (dirPath.length > 512) return { ok: false, error: 'Ruta demasiado larga' };
  try {
    const { stdout, stderr } = await execAsync(
      `docker exec "${id}" ls -la "${dirPath.replace(/"/g, '\\"')}"`,
      { timeout: 10000, env: buildDockerEnv() }
    );
    const entries = parseLsOutput(stdout || stderr);
    return { ok: true, entries, path: dirPath };
  } catch (e) { return { ok: false, error: e.stderr || e.message }; }
});

ipcMain.handle('container:copyFile', async (_, { id, srcPath, destDir }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id))
    return { ok: false, error: 'ID inválido' };
  if (!srcPath || !srcPath.startsWith('/') || SHELL_INJECT_RE.test(srcPath))
    return { ok: false, error: 'Ruta origen inválida' };
  const target   = destDir || os.homedir();
  const fileName = path.basename(srcPath);
  const dest     = path.join(target, fileName);
  try {
    const { stdout, stderr } = await execAsync(
      `docker cp "${id}:${srcPath}" "${dest}"`,
      { timeout: 120000, env: buildDockerEnv() }
    );
    return { ok: true, dest, output: (stdout + stderr).trim() };
  } catch (e) { return { ok: false, error: e.stderr || e.message }; }
});

ipcMain.handle('container:getDesktop', () => {
  const desktop = IS_WIN ? path.join(os.homedir(), 'Desktop') : os.homedir();
  return { ok: true, path: desktop };
});

// ── Helper spawn-based para docker exec (sin shell, sin escaping issues) ────
// opts: { timeoutMs, execEnv } — execEnv pasa -e KEY=VAL a docker exec
function dockerExecArgs(id, execUser, cmdArgs, opts = {}) {
  const timeoutMs = typeof opts === 'number' ? opts : (opts.timeoutMs || 15000);
  const execEnv   = typeof opts === 'object' ? (opts.execEnv || {}) : {};
  return new Promise((resolve, reject) => {
    const args = ['exec'];
    if (execUser) args.push('-u', execUser);
    Object.entries(execEnv).forEach(([k, v]) => args.push('-e', `${k}=${v}`));
    args.push(id, ...cmdArgs);
    const proc = spawn('docker', args, { env: buildDockerEnv(), windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('Timeout')); }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => { clearTimeout(timer); resolve({ stdout: out.trim(), stderr: err.trim(), code }); });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Obtiene env vars del contenedor via inspect
async function getContainerEnv(id) {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" "${id}"`,
      { timeout: 5000, env: buildDockerEnv() }
    );
    return Object.fromEntries(
      stdout.split('\n').filter(l => l.includes('=')).map(l => {
        const eq = l.indexOf('=');
        return [l.slice(0, eq), l.slice(eq + 1).trim()];
      })
    );
  } catch { return {}; }
}


// Helper interno para psql: intenta TCP (127.0.0.1) y como fallback socket via OS user postgres
// pgUser = usuario de la base de datos (POSTGRES_USER), pgPwd = contrasena opcional
async function pgExec(id, pgUser, pgPwd, psqlArgs, timeoutMs) {
  const user = pgUser || 'postgres';
  const pw   = pgPwd  || '';
  const tcpArgs  = ['psql', '-U', user, '-h', '127.0.0.1', '-p', '5432', ...psqlArgs];
  const sockArgs = ['psql', '-U', user, ...psqlArgs];
  let lastErr = '';

  // Helper para intentar y capturar resultado
  const tryExec = async (execUser, cmdArgs, env) => {
    try {
      const r = await dockerExecArgs(id, execUser, cmdArgs,
        { timeoutMs, ...(env ? { execEnv: env } : {}) });
      if (r.code === 0) return r;
      lastErr = (r.stderr || '').slice(0, 200);
    } catch (e) { lastErr = e.message; }
    return null;
  };

  // 1) TCP via URL con password (mas confiable en postgres:16-alpine)
  if (pw) {
    const safeUser = encodeURIComponent(user);
    const safePwd  = encodeURIComponent(pw);
    const connUrl  = `postgresql://${safeUser}:${safePwd}@127.0.0.1:5432/postgres`;
    const urlArgs  = ['psql', connUrl, ...psqlArgs];
    const r = await tryExec(null, urlArgs, null);
    if (r) return r;
  }

  // 2) TCP trust (sin password)
  { const r = await tryExec(null, tcpArgs, null); if (r) return r; }

  // 3) TCP con PGPASSWORD env var
  if (pw) { const r = await tryExec(null, tcpArgs, { PGPASSWORD: pw }); if (r) return r; }

  // 4) Socket como OS user postgres + PGPASSWORD
  if (pw) { const r = await tryExec('postgres', sockArgs, { PGPASSWORD: pw }); if (r) return r; }

  // 5) Socket sin password (peer auth)
  { const r = await tryExec('postgres', sockArgs, null); if (r) return r; }

  return null;  // todos los intentos fallaron - caller puede usar lastErr
}

// ─── Detectar BD ──────────────────────────────────────────────────────────────
ipcMain.handle('container:detectDb', async (_, { id }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return { ok: false, error: 'ID invalido' };
  const env = await getContainerEnv(id);

  // ── PostgreSQL ──────────────────────────────────────────────────────────────
  try {
    const vr = await dockerExecArgs(id, null, ['psql', '--version'], { timeoutMs: 4000 });
    if (vr.code === 0) {
      const pgUser = env.POSTGRES_USER || 'postgres';
      const pgPwd  = env.POSTGRES_PASSWORD || env.PGPASSWORD || '';
      const r = await pgExec(id, pgUser, pgPwd, ['-At', '-c', 'SELECT version();'], 8000);
      if (r) return { ok: true, dbType: 'postgres', label: 'PostgreSQL', pgUser, pgPwd: pgPwd || null };
      // psql existe pero ninguna estrategia conecta -> pedir credenciales al usuario
      return {
        ok: true, dbType: 'postgres', label: 'PostgreSQL', pgUser,
        needsCredentials: true,
        detail: 'No se pudo autenticar. Introduce las credenciales manualmente.'
      };
    }
  } catch {}

  // ── MySQL / MariaDB ─────────────────────────────────────────────────────────
  const mysqlPwd = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || '';
  for (const cli of ['mysql', 'mariadb']) {
    const args0 = [cli, '-uroot', '--connect-timeout=3', '-N', '-e', 'SELECT 1;'];
    const argsP = [cli, '-uroot', `--password=${mysqlPwd}`, '--connect-timeout=3', '-N', '-e', 'SELECT 1;'];
    try {
      const r = await dockerExecArgs(id, null, args0, { timeoutMs: 6000 });
      if (r.code === 0) return { ok: true, dbType: cli === 'mariadb' ? 'mariadb' : 'mysql', label: cli === 'mariadb' ? 'MariaDB' : 'MySQL', rootPwd: '' };
    } catch {}
    if (mysqlPwd) {
      try {
        const r = await dockerExecArgs(id, null, argsP, { timeoutMs: 6000 });
        if (r.code === 0) return { ok: true, dbType: cli === 'mariadb' ? 'mariadb' : 'mysql', label: cli === 'mariadb' ? 'MariaDB' : 'MySQL', rootPwd: mysqlPwd };
      } catch {}
    }
  }

  // ── MongoDB ─────────────────────────────────────────────────────────────────
  for (const cli of ['mongosh', 'mongo']) {
    try {
      const r = await dockerExecArgs(id, null, [cli, '--quiet', '--eval', 'db.adminCommand("ping")'], { timeoutMs: 5000 });
      if (r.code === 0) return { ok: true, dbType: 'mongodb', label: 'MongoDB' };
    } catch {}
  }

  // ── Redis ────────────────────────────────────────────────────────────────────
  try {
    const r = await dockerExecArgs(id, null, ['redis-cli', 'PING'], { timeoutMs: 4000 });
    if (r.code === 0 && r.stdout.includes('PONG')) return { ok: true, dbType: 'redis', label: 'Redis' };
  } catch {}

  // -- SQL Server (mssql-server image) ------------------------------------------
  const saPassword = env.SA_PASSWORD || env.MSSQL_SA_PASSWORD || env.MSSQL_SA_PASSSWORD || '';
  for (const sqlcmdBin of ['/opt/mssql-tools18/bin/sqlcmd', '/opt/mssql-tools/bin/sqlcmd', 'sqlcmd']) {
    const testArgs = saPassword
      ? [sqlcmdBin, '-S', 'localhost,1433', '-U', 'SA', '-P', saPassword, '-Q', 'SELECT 1', '-b']
      : [sqlcmdBin, '-S', 'localhost,1433', '-U', 'SA', '-P', '', '-Q', 'SELECT 1', '-b'];
    try {
      const r = await dockerExecArgs(id, null, testArgs, { timeoutMs: 6000 });
      if (r.code === 0 || (r.stderr || '').toLowerCase().includes('login failed')) {
        // sqlcmd binary exists in container
        if (r.code === 0) {
          return { ok: true, dbType: 'sqlserver', label: 'SQL Server', pgUser: 'SA', pgPwd: saPassword || null, sqlcmdBin };
        }
        // binary found but login failed -> ask for credentials
        return {
          ok: true, dbType: 'sqlserver', label: 'SQL Server', pgUser: 'SA', sqlcmdBin,
          needsCredentials: true,
          detail: 'Login fallido. Introduce las credenciales SA manualmente.'
        };
      }
    } catch {}
  }

  return { ok: true, dbType: null, label: 'No detectada', detail: 'Sin BD compatible encontrada' };
});

// ─── Verificar credenciales manuales PostgreSQL ────────────────────────────────
ipcMain.handle('container:verifyDbCredentials', async (_, { id, dbType, user, password }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return { ok: false, error: 'ID invalido' };
  if (!user || typeof user !== 'string' || user.length > 64) return { ok: false, error: 'Usuario invalido' };
  try {
    if (dbType === 'postgres') {
      const r = await pgExec(id, user, password || '', ['-At', '-c', 'SELECT version();'], 10000);
      if (r) return { ok: true, pgUser: user, pgPwd: password || null };
      // Run one more attempt to capture specific error for the user
      try {
        const dbg = await dockerExecArgs(id, null,
          ['psql', '-U', user, '-h', '127.0.0.1', '-p', '5432', '-At', '-c', 'SELECT 1;'],
          { timeoutMs: 5000, ...(password ? { execEnv: { PGPASSWORD: password } } : {}) });
        const errMsg = (dbg.stderr || '').replace(/[\r\n]+/g, ' ').slice(0, 150);
        return { ok: false, error: errMsg || 'Sin acceso (todas las estrategias fallaron)' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    if (dbType === 'mysql' || dbType === 'mariadb') {
      const cli  = dbType === 'mariadb' ? 'mariadb' : 'mysql';
      const args = password
        ? [cli, `-u${user}`, `--password=${password}`, '--connect-timeout=3', '-N', '-e', 'SELECT 1;']
        : [cli, `-u${user}`, '--connect-timeout=3', '-N', '-e', 'SELECT 1;'];
      const r = await dockerExecArgs(id, null, args, { timeoutMs: 6000 });
      return r.code === 0 ? { ok: true, rootPwd: password || '' } : { ok: false, error: r.stderr.slice(0, 120) };
    }
    if (dbType === 'sqlserver') {
      for (const bin of ['/opt/mssql-tools18/bin/sqlcmd', '/opt/mssql-tools/bin/sqlcmd', 'sqlcmd']) {
        try {
          const r = await dockerExecArgs(id, null,
            [bin, '-S', 'localhost,1433', '-U', user, '-P', password || '', '-Q', 'SELECT 1', '-b'],
            { timeoutMs: 8000 });
          if (r.code === 0) return { ok: true, pgUser: user, pgPwd: password || null, sqlcmdBin: bin };
        } catch {}
      }
      return { ok: false, error: 'Login SA fallido. Verifica la contrasena SA.' };
    }
    return { ok: false, error: 'Tipo no soportado para verificacion manual' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Listar bases de datos ─────────────────────────────────────────────────────
ipcMain.handle('container:listDbs', async (_, { id, dbType, pgUser, pgPwd, rootPwd }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return { ok: false, error: 'ID invalido' };
  try {
    let r;
    if (dbType === 'postgres') {
      r = await pgExec(id, pgUser, pgPwd,
        ['-At', '-c', "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname;"],
        10000);
      if (!r) return { ok: false, error: 'No se pudo conectar a PostgreSQL' };
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      const cli  = dbType === 'mariadb' ? 'mariadb' : 'mysql';
      const args = [cli, '-uroot', '-N', '-e', 'SHOW DATABASES;'];
      if (rootPwd) args.splice(2, 0, `--password=${rootPwd}`);
      r = await dockerExecArgs(id, null, args, { timeoutMs: 10000 });
    } else if (dbType === 'mongodb') {
      r = await dockerExecArgs(id, null, ['mongosh', '--quiet', '--eval',
        'db.adminCommand({listDatabases:1}).databases.forEach(d => print(d.name))'], { timeoutMs: 10000 });
    } else if (dbType === 'redis') {
      r = await dockerExecArgs(id, null, ['redis-cli', 'INFO', 'keyspace'], { timeoutMs: 6000 });
      const dbs = r.stdout.split('\n').filter(l => l.startsWith('db')).map(l => l.split(':')[0]);
      return { ok: true, databases: dbs.length ? dbs : ['db0'] };
    } else if (dbType === 'sqlserver') {
      const saUser = pgUser || 'SA'; const saPwd = pgPwd || '';
      const q = "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE name NOT IN ('master','model','msdb','tempdb') ORDER BY name;";
      let r2;
      for (const b of ['/opt/mssql-tools18/bin/sqlcmd', '/opt/mssql-tools/bin/sqlcmd', 'sqlcmd']) {
        try {
          r2 = await dockerExecArgs(id, null, [b, '-S', 'localhost,1433', '-U', saUser, '-P', saPwd, '-h', '-1', '-W', '-Q', q], { timeoutMs: 12000 });
          if (r2.code === 0) break;
        } catch {}
      }
      if (!r2 || r2.code !== 0) return { ok: false, error: (r2 && r2.stderr) ? r2.stderr.slice(0, 200) : 'No se pudo conectar a SQL Server' };
      const dbs = r2.stdout.split('\n').map(l => l.trim()).filter(l => l && l !== 'NULL' && !/^[-\s]+$/.test(l));
      return { ok: true, databases: dbs };
    } else {
      return { ok: false, error: 'Tipo no soportado' };
    }
    const dbs = r.stdout.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^[-+|]/));
    return { ok: r.code === 0, databases: dbs, error: r.code !== 0 ? r.stderr.slice(0, 200) : null };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Listar tablas / colecciones ──────────────────────────────────────────────
ipcMain.handle('container:listTables', async (_, { id, dbType, database, pgUser, pgPwd, rootPwd }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return { ok: false, error: 'ID invalido' };
  if (!database || !/^[a-zA-Z0-9_\-]{1,128}$/.test(database)) return { ok: false, error: 'BD invalida' };
  try {
    let r;
    if (dbType === 'postgres') {
      r = await pgExec(id, pgUser, pgPwd,
        ['-At', '-d', database, '-c',
         "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname NOT IN ('information_schema','pg_catalog') ORDER BY tablename;"],
        10000);
      if (!r) return { ok: false, error: 'No se pudo conectar a PostgreSQL' };
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      const cli  = dbType === 'mariadb' ? 'mariadb' : 'mysql';
      const args = [cli, '-uroot', '-N', database, '-e', 'SHOW TABLES;'];
      if (rootPwd) args.splice(2, 0, `--password=${rootPwd}`);
      r = await dockerExecArgs(id, null, args, { timeoutMs: 10000 });
    } else if (dbType === 'mongodb') {
      r = await dockerExecArgs(id, null, ['mongosh', '--quiet', database, '--eval',
        'db.getCollectionNames().forEach(c => print(c))'], { timeoutMs: 10000 });
    } else if (dbType === 'redis') {
      r = await dockerExecArgs(id, null, ['redis-cli', '-n', database.replace('db', ''), 'KEYS', '*'], { timeoutMs: 10000 });
    } else if (dbType === 'sqlserver') {
      const saUser = pgUser || 'SA'; const saPwd = pgPwd || '';
      const q = `SET NOCOUNT ON; SELECT TABLE_SCHEMA+'.'+TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;`;
      for (const b of ['/opt/mssql-tools18/bin/sqlcmd', '/opt/mssql-tools/bin/sqlcmd', 'sqlcmd']) {
        try {
          r = await dockerExecArgs(id, null, [b, '-S', 'localhost,1433', '-U', saUser, '-P', saPwd, '-d', database, '-h', '-1', '-W', '-Q', q], { timeoutMs: 12000 });
          if (r.code === 0) break;
        } catch {}
      }
      if (!r || r.code !== 0) return { ok: false, error: (r && r.stderr) ? r.stderr.slice(0, 200) : 'No se pudo conectar a SQL Server' };
      const tables = r.stdout.split('\n').map(l => l.trim()).filter(l => l && l !== 'NULL' && !/^[-\s]+$/.test(l));
      return { ok: true, tables };
    } else {
      return { ok: false, error: 'Tipo no soportado' };
    }
    const tables = r.stdout.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^[-+|]/));
    return { ok: r.code === 0, tables, error: r.code !== 0 ? r.stderr.slice(0, 200) : null };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Ejecutar consulta ─────────────────────────────────────────────────────────
ipcMain.handle('container:queryDb', async (_, { id, dbType, database, sql, pgUser, pgPwd, rootPwd }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return { ok: false, error: 'ID invalido' };
  if (!sql || typeof sql !== 'string' || sql.length > 8000) return { ok: false, error: 'Query invalida' };
  try {
    let r;
    if (dbType === 'postgres') {
      const extra = ['-P', 'pager=off'];
      if (database) extra.push('-d', database);
      extra.push('-c', sql);
      r = await pgExec(id, pgUser, pgPwd, extra, 30000);
      if (!r) return { ok: false, error: 'No se pudo conectar a PostgreSQL' };
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      const cli  = dbType === 'mariadb' ? 'mariadb' : 'mysql';
      const args = [cli, '-uroot', '--table'];
      if (rootPwd) args.push(`--password=${rootPwd}`);
      if (database) args.push(database);
      args.push('-e', sql);
      r = await dockerExecArgs(id, null, args, { timeoutMs: 30000 });
    } else if (dbType === 'mongodb') {
      r = await dockerExecArgs(id, null, ['mongosh', '--quiet', database || 'admin', '--eval', sql], { timeoutMs: 30000 });
    } else if (dbType === 'redis') {
      r = await dockerExecArgs(id, null, ['redis-cli', ...sql.trim().split(/\s+/)], { timeoutMs: 10000 });
    } else if (dbType === 'sqlserver') {
      const saUser = pgUser || 'SA'; const saPwd = pgPwd || '';
      const args = ['-S', 'localhost,1433', '-U', saUser, '-P', saPwd];
      if (database) args.push('-d', database);
      args.push('-Q', sql);
      for (const b of ['/opt/mssql-tools18/bin/sqlcmd', '/opt/mssql-tools/bin/sqlcmd', 'sqlcmd']) {
        try {
          r = await dockerExecArgs(id, null, [b, ...args], { timeoutMs: 30000 });
          if (r.code === 0 || r.stderr) break;
        } catch {}
      }
      if (!r) return { ok: false, error: 'sqlcmd no encontrado en el contenedor' };
    } else {
      return { ok: false, error: 'Tipo no soportado' };
    }
    const output = ((r.stdout || '') + (r.code !== 0 && r.stderr ? '\n-- STDERR --\n' + r.stderr : '')).trim();
    return { ok: r.code === 0, output: output.slice(0, 80000) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Red / IPs del contenedor ─────────────────────────────────────────────────
ipcMain.handle('container:getNetworkInfo', async (_, { id }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return { ok: false, error: 'ID invalido' };
  try {
    const { stdout } = await execAsync(
      `docker inspect --format "{{json .NetworkSettings}}" "${id}"`,
      { timeout: 8000, env: buildDockerEnv() }
    );
    const ns = JSON.parse(stdout);
    const networks = Object.entries(ns.Networks || {}).map(([netName, net]) => ({
      name: netName, ip: net.IPAddress || '', gateway: net.Gateway || '', mac: net.MacAddress || '',
    }));
    const ports = Object.entries(ns.Ports || {}).reduce((acc, [port, bindings]) => {
      if (bindings && bindings.length) {
        bindings.forEach(b => acc.push({ container: port, host: b.HostPort, hostIp: b.HostIp || '0.0.0.0' }));
      } else {
        acc.push({ container: port, host: null, hostIp: null });
      }
      return acc;
    }, []);
    return { ok: true, networks, ports };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Puertos en escucha ────────────────────────────────────────────────────────
ipcMain.handle('container:getListeningPorts', async (_, { id }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return { ok: false, error: 'ID invalido' };
  for (const cmd of [['ss', '-tlnp'], ['netstat', '-tlnp']]) {
    try {
      const r = await dockerExecArgs(id, null, cmd, { timeoutMs: 5000 });
      if (r.code === 0) {
        const lines = r.stdout.split('\n').filter(l => /:\d+/.test(l) && /LISTEN/i.test(l));
        return { ok: true, lines };
      }
    } catch {}
  }
  return { ok: true, lines: [] };
});

// ─── Listar redes Docker (filtra host y none) ──────────────────────────────────
ipcMain.handle('container:listNetworks', async () => {
  try {
    const { stdout } = await execAsync('docker network ls --format "{{json .}}"',
      { timeout: 8000, env: buildDockerEnv() });
    const networks = stdout.trim().split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(n => n && n.Driver !== 'host' && n.Driver !== 'null' && n.Name !== 'none' && n.Driver !== 'null');
    return { ok: true, networks };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Conectar/desconectar contenedor de red ────────────────────────────────────
ipcMain.handle('container:networkAction', async (_, { id, action, network, staticIp }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id))     return { ok: false, error: 'ID invalido' };
  if (!/^[a-zA-Z0-9_.\- ]{1,128}$/.test(network)) return { ok: false, error: 'Red invalida' };
  if (!['connect', 'disconnect'].includes(action))  return { ok: false, error: 'Accion invalida' };

  // Validar IP estatica si se proporciona
  const ipFlag = staticIp && /^(\d{1,3}\.){3}\d{1,3}$/.test(staticIp) ? `--ip ${staticIp}` : '';

  try {
    const cmd = `docker network ${action} ${ipFlag} "${network}" "${id}"`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: 15000, env: buildDockerEnv() });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (e) {
    const msg = (e.stderr || e.message || '');
    // Si ya esta conectado, considerarlo OK con advertencia
    if (action === 'connect' && msg.includes('already exists')) {
      return { ok: true, alreadyConnected: true, output: 'El contenedor ya esta en esta red' };
    }
    return { ok: false, error: msg.slice(0, 200) };
  }
});

// ─── Renombrar contenedor ──────────────────────────────────────────────────────
ipcMain.handle('container:rename', async (_, { id, newName }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id))           return { ok: false, error: 'ID invalido' };
  if (!newName || !/^[a-zA-Z0-9_.\-]{1,64}$/.test(newName)) return { ok: false, error: 'Nombre invalido (solo letras, numeros, - _ .)' };
  try {
    const { stdout, stderr } = await execAsync(
      `docker rename "${id}" "${newName}"`,
      { timeout: 8000, env: buildDockerEnv() }
    );
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (e) { return { ok: false, error: e.stderr || e.message }; }
});

// ─── WSL: info de red ──────────────────────────────────────────────────────────
ipcMain.handle('wsl:getNetworkInfo', async (_, { distro }) => {
  if (!IS_WIN) return { ok: false, error: 'Solo Windows' };
  if (!isValidDistroName(distro)) return { ok: false, error: 'Nombre invalido' };
  try {
    // hostname -I con LANG=C para evitar caracteres no latinos en distros con locale asiatico
    const ipRes = await wslRun(['-d', distro, '--', 'sh', '-c',
      'LANG=C LC_ALL=C hostname -I 2>/dev/null | tr " " "\\n" | grep -v "^$" | head -5'], 8000);
    const ips = ipRes.stdout.trim().split(/\r?\n/)
      .map(l => l.trim()).filter(ip => ip && !ip.startsWith('127.'))
      .map(ip => ({ ip, cidr: ip, iface: '?' }));

    const portRes = await wslRun(['-d', distro, '--', 'sh', '-c',
      'LANG=C ss -tlnp 2>/dev/null || LANG=C netstat -tlnp 2>/dev/null || echo ""'], 8000);
    const portLines = portRes.stdout.split(/\r?\n/).filter(l => /LISTEN/i.test(l) && /:\d+/.test(l));

    const gwRes = await wslRun(['-d', distro, '--', 'sh', '-c',
      "LANG=C ip route 2>/dev/null | grep '^default' | awk '{print $3}' | head -1"], 5000);
    const gateway = gwRes.stdout.trim();

    return { ok: true, ips, portLines, gateway };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Abrir terminal del contenedor ────────────────────────────────────────────
ipcMain.handle('container:openTerminal', async (_, { id }) => {
  if (!/^[a-zA-Z0-9_.\-]{1,128}$/.test(id)) return { ok: false, error: 'ID invalido' };
  if (IS_WIN) {
    const { spawnSync } = require('child_process');
    const wt = spawnSync('where', ['wt.exe'], { windowsHide: true, shell: true });
    if (wt.status === 0) {
      spawn('wt.exe', ['docker', 'exec', '-it', id, 'sh', '-c', 'bash 2>/dev/null || sh'],
        { detached: true, windowsHide: false });
    } else {
      spawn('cmd.exe', ['/c', `start cmd.exe /k docker exec -it ${id} sh -c "bash 2>/dev/null || sh"`],
        { detached: true, shell: true });
    }
  } else if (IS_MAC) {
    spawn('open', ['-a', 'Terminal'], { detached: true });
  } else {
    spawn('bash', ['-c', `gnome-terminal -- docker exec -it "${id}" bash 2>/dev/null || xterm -e "docker exec -it ${id} bash" 2>/dev/null || konsole -e "docker exec -it ${id} bash" 2>/dev/null || true`],
      { detached: true, shell: true });
  }
  return { ok: true };
});

// =============================================================================
// CICLO DE VIDA
// =============================================================================
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  activeStreams.forEach(p => { try { p.kill(); } catch {} });
});
