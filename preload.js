// preload.js -- Bridge seguro entre Electron main y renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dockerAPI', {

  // Docker
  test:                ()           => ipcRenderer.invoke('docker:test'),
  getContainers:       ()           => ipcRenderer.invoke('docker:getContainers'),
  getStats:            ()           => ipcRenderer.invoke('docker:getStats'),
  getImages:           ()           => ipcRenderer.invoke('docker:getImages'),
  getVolumes:          ()           => ipcRenderer.invoke('docker:getVolumes'),
  getSystemDf:         ()           => ipcRenderer.invoke('docker:getSystemDf'),
  getInfo:             ()           => ipcRenderer.invoke('docker:getInfo'),
  getProjects:         ()           => ipcRenderer.invoke('docker:getProjects'),
  containerAction:     (id, action) => ipcRenderer.invoke('docker:containerAction', { id, action }),
  getLogs:             (id, lines)  => ipcRenderer.invoke('docker:getLogs', { id, lines }),
  findTransferScripts:  (startPath)  => ipcRenderer.invoke('docker:findTransferScripts', startPath),
  dockerScanProject:    (opts)       => ipcRenderer.invoke('docker:scanProject', opts),
  dockerStopByNames:    (opts)       => ipcRenderer.invoke('docker:stopByNames', opts),
  dockerBuildBundle:    (opts)       => ipcRenderer.send('docker:buildBundle', opts),
  pruneSystem:         (what)       => ipcRenderer.invoke('docker:pruneSystem', what),
  removeImage:         (id)         => ipcRenderer.invoke('docker:removeImage', id),
  removeVolume:        (name)       => ipcRenderer.invoke('docker:removeVolume', name),

  // Streaming
  streamLogs:   (id, streamId)                   => ipcRenderer.send('docker:streamLogs', { id, streamId }),
  runScript:    (scriptPath, args, streamId, cwd) => ipcRenderer.send('docker:runScript', { scriptPath, args, streamId, cwd }),
  killStream:   (streamId)                       => ipcRenderer.send('stream:kill', { streamId }),
  onStreamData: (cb) => { ipcRenderer.on('stream:data', (_, payload) => cb(payload)); },
  onStreamEnd:  (cb) => { ipcRenderer.on('stream:end',  (_, payload) => cb(payload)); },
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners('stream:data');
    ipcRenderer.removeAllListeners('stream:end');
  },

  // Dialogos
  openFile:   (options) => ipcRenderer.invoke('dialog:openFile', options),
  openFolder: ()        => ipcRenderer.invoke('dialog:openFolder'),
  saveFile:   (options) => ipcRenderer.invoke('dialog:saveFile', options),

  // Sistema de archivos
  openInExplorer: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  fileExists:     (filePath) => ipcRenderer.invoke('fs:exists', filePath),
  readDir:        (dirPath)  => ipcRenderer.invoke('fs:readDir', dirPath),

  // Remote Docker
  remoteConnect:    (opts) => ipcRenderer.invoke('docker:remoteConnect', opts),
  remoteDisconnect: ()     => ipcRenderer.invoke('docker:remoteDisconnect'),
  remoteStatus:     ()     => ipcRenderer.invoke('docker:remoteStatus'),

  // Transferencia por red
  scpTransfer: (opts, streamId) => ipcRenderer.send('transfer:scp', { ...opts, streamId }),

  // Cloud
  getCloudCommands: (opts)    => ipcRenderer.invoke('cloud:getCommands', opts),
  runCloudCommand:  (cmd, id) => ipcRenderer.send('cloud:runCommand', { command: cmd, streamId: id }),
  cloudDockerLogin: (opts)    => ipcRenderer.invoke('cloud:dockerLogin', opts),
  cloudAwsEcrLogin: (opts)    => ipcRenderer.invoke('cloud:awsEcrLogin', opts),
  cloudListRepos:   (opts)    => ipcRenderer.invoke('cloud:listRepos', opts),
  cloudListTags:    (opts)    => ipcRenderer.invoke('cloud:listTags', opts),

  // Utilidades
  platform: () => ipcRenderer.invoke('util:platform'),

  // Version y dependencias
  getAppVersion: ()           => ipcRenderer.invoke('app:getVersion'),
  checkUpdates:  ()           => ipcRenderer.invoke('app:checkUpdates'),
  updatePackage: (name, ver)  => ipcRenderer.invoke('app:updatePackage', { name, version: ver }),
  auditDeps:     ()           => ipcRenderer.invoke('app:auditDeps'),

  // WSL
  wslList:               ()                       => ipcRenderer.invoke('wsl:list'),
  wslAction:             (action, distro)          => ipcRenderer.invoke('wsl:action', { action, distro }),
  wslSetVersion:         (distro, version)         => ipcRenderer.invoke('wsl:setVersion', { distro, version }),
  wslGetResources:       (distro)                  => ipcRenderer.invoke('wsl:getResources', { distro }),
  wslSshStatus:          (distro)                  => ipcRenderer.invoke('wsl:sshStatus', { distro }),
  wslGetMounts:          (distro)                  => ipcRenderer.invoke('wsl:getMounts', { distro }),
  wslOpenExplorer:       (distro)                  => ipcRenderer.invoke('wsl:openExplorer', { distro }),
  wslOpenTerminal:       (distro)                  => ipcRenderer.invoke('wsl:openTerminal', { distro }),
  wslOpenTerminalScript: (distro, key)             => ipcRenderer.invoke('wsl:openTerminalScript', { distro, scriptKey: key }),
  wslStreamPreset:       (distro, preset, id)      => ipcRenderer.send('wsl:streamPreset', { distro, preset, streamId: id }),
  wslStreamBindMount:    (distro, win, mp, id)     => ipcRenderer.send('wsl:streamBindMount', { distro, winPath: win, mountPoint: mp, streamId: id }),
  wslStreamTransfer:     (distro, paths, dst, id)  => ipcRenderer.send('wsl:streamTransfer', { distro, winPaths: paths, destPath: dst, streamId: id }),
  wslExportDialog:       (distro)                  => ipcRenderer.invoke('wsl:exportDialog', { distro }),
  wslExportPick:         (distro)                  => ipcRenderer.invoke('wsl:exportPick',   { distro }),
  wslExportRun:          (distro, filePath, sid)   => ipcRenderer.invoke('wsl:exportRun',    { distro, filePath, streamId: sid }),
  wslGetFileSize:        (filePath)               => ipcRenderer.invoke('wsl:getFileSize', { filePath }),
  wslImportDialog:       ()                        => ipcRenderer.invoke('wsl:importDialog'),
  wslImport:             (name, dir, src)          => ipcRenderer.invoke('wsl:import', { name, installDir: dir, srcPath: src }),
  wslListDisks:          ()                        => ipcRenderer.invoke('wsl:listDisks'),
  wslSshChangePort:      (distro, port)            => ipcRenderer.invoke('wsl:sshChangePort', { distro, port }),
  wslOpenVhdxDir:        (opts)                    => ipcRenderer.invoke('wsl:openVhdxDir', opts),
  wslOpenFolder:         (folderPath)              => ipcRenderer.invoke('wsl:openFolder', { folderPath }),
  wslExportToNetwork:    (distro, destPath)        => ipcRenderer.invoke('wsl:exportToNetwork', { distro, destPath }),
  // Remote WSL management
  wslRemoteList:        (opts)                    => ipcRenderer.invoke('wsl:remoteList',      opts),
  wslRemoteAction:      (opts)                    => ipcRenderer.invoke('wsl:remoteAction',    opts),
  wslRemoteResources:   (opts)                    => ipcRenderer.invoke('wsl:remoteResources', opts),
  wslRemoteShell:       (opts, streamId)          => ipcRenderer.invoke('wsl:remoteShell',     { ...opts, streamId }),
  wslGetNetworkInfo:     (distro)                  => ipcRenderer.invoke('wsl:getNetworkInfo', { distro }),

  // Explorador de contenedores
  containerListDir:             (id, dirPath)                                              => ipcRenderer.invoke('container:listDir',              { id, dirPath }),
  containerCopyFile:            (id, srcPath, destDir)                                    => ipcRenderer.invoke('container:copyFile',             { id, srcPath, destDir }),
  containerGetDesktop:          ()                                                         => ipcRenderer.invoke('container:getDesktop'),
  containerDetectDb:            (id)                                                       => ipcRenderer.invoke('container:detectDb',             { id }),
  containerListDbs:             (id, dbType, pgUser, pgPwd, rootPwd)                      => ipcRenderer.invoke('container:listDbs',              { id, dbType, pgUser, pgPwd, rootPwd }),
  containerListTables:          (id, dbType, database, pgUser, pgPwd, rootPwd)            => ipcRenderer.invoke('container:listTables',           { id, dbType, database, pgUser, pgPwd, rootPwd }),
  containerQueryDb:             (id, dbType, database, sql, pgUser, pgPwd, rootPwd)       => ipcRenderer.invoke('container:queryDb',              { id, dbType, database, sql, pgUser, pgPwd, rootPwd }),
  containerVerifyDbCredentials: (id, dbType, user, password)                              => ipcRenderer.invoke('container:verifyDbCredentials',  { id, dbType, user, password }),
  containerGetNetworkInfo:      (id)                                                       => ipcRenderer.invoke('container:getNetworkInfo',       { id }),
  containerGetListeningPorts:   (id)                                                       => ipcRenderer.invoke('container:getListeningPorts',    { id }),
  containerListNetworks:        ()                                                         => ipcRenderer.invoke('container:listNetworks'),
  containerNetworkAction:       (id, action, network, staticIp)                           => ipcRenderer.invoke('container:networkAction',        { id, action, network, staticIp }),
  containerRename:              (id, newName)                                              => ipcRenderer.invoke('container:rename',               { id, newName }),
  containerOpenTerminal:        (id)                                                       => ipcRenderer.invoke('container:openTerminal',         { id }),

  // Terminal SSH embebida
  wslOpenShell:    (distro, streamId)               => ipcRenderer.invoke('wsl:openShell',   { distro, streamId }),
  wslSshConnect:   (opts, streamId)                 => ipcRenderer.invoke('wsl:sshConnect',  { ...opts, streamId }),
  streamStdin:     (streamId, data)                 => ipcRenderer.send('stream:stdin',       { streamId, data }),
});
