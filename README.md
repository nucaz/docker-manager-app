# Docker Manager

Herramienta gráfica de escritorio (Electron) para gestionar contenedores, imágenes, volúmenes y proyectos Docker — con soporte para transferencia SCP, registros cloud y administración de WSL.

---

## Características principales

| Pestaña | Funcionalidad |
|---------|---------------|
| **Contenedores** | Listar, iniciar, detener, reiniciar, pausar, eliminar; logs en tiempo real; estadísticas de CPU/RAM/Red/Disco |
| **Imágenes** | Listar, filtrar, eliminar; prune de imágenes no usadas |
| **Volúmenes** | Listar, eliminar, prune; uso de disco |
| **Transferir** | Escanear proyectos Compose, exportar bundles y enviar vía SCP a servidores remotos |
| **Remote / Cloud** | Conectar a Docker remoto; push a Docker Hub, AWS ECR, Azure ACR, Huawei SWR, VPS privado |
| **Logs** | Streaming en tiempo real con filtros y resaltado de errores/warnings |
| **WSL** | Gestionar distribuciones WSL (listar, iniciar, exportar/importar, mounts, SSH, terminal) |
| **Configuración** | Auto-refresh, versiones, **detección y actualización de dependencias** |

---

## Requisitos

- [Node.js](https://nodejs.org/) ≥ 18
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado y en ejecución
- Windows 10/11 (soporte completo), Linux, macOS 10.15+

---

## Instalación y ejecución

```bash
# 1. Instalar dependencias
npm install

# 2. Lanzar la aplicación
npm start

# Modo desarrollo (con DevTools)
npm run dev
```

---

## Construir instalador

```bash
# Windows (.exe + portable)
npm run build:win

# Linux (.AppImage + .deb + .rpm)
npm run build:linux

# macOS (.dmg + .zip — requiere macOS)
npm run build:mac

# Todas las plataformas
npm run build:all
```

El instalador queda en la carpeta `dist/`.

---

## Seguridad de dependencias

La aplicación incluye **detección automática de dependencias desactualizadas y vulnerabilidades** al arrancar:

- Al iniciar, se ejecutan `npm outdated` y `npm audit` en segundo plano.
- Si se detectan actualizaciones o vulnerabilidades, aparece un **banner de advertencia** en la parte superior.
- Desde **Configuración → Dependencias** puedes ver el estado de cada paquete y actualizarlo con un clic.

```bash
# Auditoría manual de seguridad
npm run audit

# Aplicar fixes automáticos de npm
npm run audit:fix

# Ver paquetes desactualizados
npm run outdated

# Actualizar todas las dependencias
npm run deps:update
```

---

## Estructura del proyecto

```
docker-manager-app/
├── main.js            ← Proceso principal: comandos Docker, IPC, seguridad
├── preload.js         ← Bridge seguro main ↔ renderer (contextBridge)
├── renderer/
│   ├── index.html     ← Estructura HTML de la UI
│   ├── app.js         ← Lógica del renderer
│   └── styles.css     ← Tema oscuro profesional
├── assets/            ← Iconos e instalador NSIS
├── dist/              ← Builds generados
└── package.json
```

---

## Medidas de seguridad implementadas

- **Electron hardening**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `devTools` solo en desarrollo.
- **Sin inyección de shell**: todos los comandos Docker usan `spawn()` con array de argumentos, sin concatenación de strings.
- **Validación de inputs**: regex estricto para IDs de contenedor, nombres de paquete, versiones, rutas y acciones permitidas (whitelist).
- **Bloqueo de navegación**: se previene `will-navigate` a URLs externas; los links externos se abren en el navegador del sistema.
- **DevTools bloqueados en producción**: el menú y el atajo de teclado solo están disponibles en modo `--dev`.
- **Credenciales por stdin**: contraseñas se envían al proceso hijo por stdin, nunca como argumento de línea de comandos.
- **Timeout de procesos**: todas las operaciones Docker tienen timeout configurable (default 30 s).
- **npm audit al inicio**: se detectan vulnerabilidades automáticamente y se notifica al usuario.

Ver [SECURITY-REPORT.pdf](SECURITY-REPORT.pdf) para el análisis completo.

---

## Iteraciones

| # | Contenido | Estado |
|---|-----------|--------|
| 1 | Dashboard contenedores, imágenes, volúmenes, logs, transferir | ✅ |
| 2 | Compose project manager, editor .env, métricas avanzadas, cloud registries | ✅ |
| 3 | WSL manager, explorador de archivos, DB explorer, terminal SSH embebida | ✅ |
| 4 | Auditoría de seguridad, detección automática de dependencias, fixes de hardening | ✅ |
| 5 | Auto-update, exportar a PDF/Excel | Próximo |

---

## Licencia

MIT © 2026 JC
