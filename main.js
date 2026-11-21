/**
 * Vertex 代理桌面控制台（Electron 主进程）
 *
 * A 方案：Electron 全托管
 *  - 8318 已有代理 → 直接接管显示，不抢占
 *  - 没有 → 按配置启动 vertex_proxy.js（ELECTRON_RUN_AS_NODE，免装 Node）
 *  - 代理退出码 75（管理页「重启」）→ 自动重新拉起
 *  - 关窗隐藏到托盘，托盘菜单可停止代理并退出
 *  - 配置写在 %APPDATA%\vertex-proxy-console\vertex_proxy.config.json，安装目录只读也能用
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

let port = Number(process.env.VERTEX_PORT || 8318);
let base = `http://127.0.0.1:${port}`;
let adminUrl = `${base}/admin`;

let win = null;
let tray = null;
let proxyProc = null;
let quitting = false;
let ownsProxy = false;
let proxyScript = null;
let proxyDir = null;
let logLines = [];
let state = { phase: 'init', message: '准备中', detail: '', needConfig: false };

app.setAppUserModelId('com.dsh.vertex-proxy-console');

// ---------------- UI 通信 ----------------
function sendUi(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setState(phase, message, detail, needConfig) {
  state = { phase, message, detail: detail || '', needConfig: !!needConfig };
  sendUi('vx:state', state);
}

function log(line) {
  const text = String(line).replace(/\r$/, '');
  if (!text.trim()) return;
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = `${stamp}  ${text}`;
  logLines.push(entry);
  if (logLines.length > 300) logLines.shift();
  sendUi('vx:log', entry);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 探测代理 ----------------
function probe(timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/status`, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, status: JSON.parse(body) });
        } catch {
          resolve({ ok: false, error: 'bad json' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

function testTcp(host, tport, timeout = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok, error: error || '' });
    };
    const sock = net.connect({ host, port: tport });
    sock.setTimeout(timeout);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false, '连接超时'));
    sock.on('error', (e) => finish(false, e.code || e.message));
  });
}

// ---------------- 定位代理脚本 ----------------
function proxyDirCandidates() {
  const list = [];
  if (process.env.VERTEX_PROXY_DIR) list.push(process.env.VERTEX_PROXY_DIR);
  list.push(path.join(__dirname, 'proxy'));                                   // 源码布局
  list.push(path.join(__dirname, '..', 'proxy'));                             // 兼容上级目录
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'proxy')); // 打包后
  return list;
}

function findProxy() {
  for (const dir of proxyDirCandidates()) {
    const p = path.join(dir, 'vertex_proxy.js');
    try {
      if (fs.existsSync(p)) return { script: p, dir };
    } catch { /* ignore */ }
  }
  return null;
}

// ---------------- 配置 ----------------
function configFile() {
  return path.join(app.getPath('userData'), 'vertex_proxy.config.json');
}

function legacyConfigFile() {
  return proxyDir ? path.join(proxyDir, 'vertex_proxy.config.json') : null;
}

function readConfig() {
  const files = [configFile(), legacyConfigFile()].filter(Boolean);
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j && typeof j === 'object') return j;
      }
    } catch { /* 继续找下一个 */ }
  }
  return {};
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    log('写入配置失败：' + e.message);
    return false;
  }
}

function resolveSaPath(cfg) {
  const p = process.env.VERTEX_SA || cfg.saPath;
  if (!p) return null;
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}

function readSaInfo(p) {
  const out = { path: p || '', valid: false, projectId: '', clientEmail: '', error: '' };
  if (!p) return out;
  try {
    if (!fs.existsSync(p)) { out.error = '文件不存在'; return out; }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    out.projectId = j.project_id || '';
    out.clientEmail = j.client_email || '';
    out.valid = !!(j.client_email && j.private_key && j.project_id);
    if (!out.valid) out.error = '缺少 client_email / private_key / project_id';
  } catch (e) {
    out.error = '读取失败：' + e.message;
  }
  return out;
}

function normalizeConfig(input) {
  const cfg = {
    saPath: String(input.saPath || '').trim(),
    port: Number(input.port) || 8318,
    location: String(input.location || 'global').trim() || 'global',
    proxyHost: String(input.proxyHost || '127.0.0.1').trim() || '127.0.0.1',
    proxyPort: Number(input.proxyPort) || 7897,
    useProxy: input.useProxy !== false,
  };
  if (!(cfg.port >= 1024 && cfg.port <= 65535)) return { error: '端口需在 1024–65535 之间' };
  if (!cfg.saPath) return { error: '还没有选择 SA 文件' };
  const sa = readSaInfo(cfg.saPath);
  if (!sa.valid) return { error: 'SA 文件无效：' + (sa.error || '请选择服务账户 JSON') };
  if (cfg.useProxy) {
    if (!cfg.proxyHost) return { error: '上游代理地址不能为空' };
    if (!(cfg.proxyPort > 0 && cfg.proxyPort <= 65535)) return { error: '上游代理端口不合法' };
  }
  return { cfg, sa };
}

function applyPort(cfg) {
  if (cfg && cfg.port) {
    port = Number(cfg.port) || port;
    base = `http://127.0.0.1:${port}`;
    adminUrl = `${base}/admin`;
  }
}

// ---------------- 启动 / 停止 ----------------
function startProxy(cfg) {
  if (!proxyScript) return false;

  const saPath = resolveSaPath(cfg);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    VERTEX_PORT: String(port),
    VERTEX_SA: saPath || '',
    VERTEX_LOCATION: cfg.location || 'global',
    VERTEX_PROXY_HOST: cfg.proxyHost || '127.0.0.1',
    VERTEX_PROXY_PORT: String(cfg.proxyPort || 7897),
  };
  if (cfg.useProxy === false) env.VERTEX_NO_PROXY = '1';

  log('启动代理：' + proxyScript);
  try {
    proxyProc = spawn(process.execPath, [proxyScript], {
      cwd: path.dirname(proxyScript),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (e) {
    log('spawn 失败：' + e.message);
    return false;
  }

  ownsProxy = true;

  const onData = (buf) => {
    String(buf).split('\n').forEach((line) => {
      if (line.trim()) log(line);
    });
  };
  proxyProc.stdout.on('data', onData);
  proxyProc.stderr.on('data', onData);

  proxyProc.on('exit', (code, signal) => {
    proxyProc = null;
    log(`代理进程退出 code=${code}${signal ? ' signal=' + signal : ''}`);
    if (quitting) return;

    if (code === 75) {
      log('收到重载请求，1 秒后重新拉起');
      setTimeout(() => { if (!quitting) boot(); }, 1000);
      return;
    }
    if (code === 0) {
      setState('stopped', '代理已停止', '点击「重新启动」可再次运行');
      if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'index.html'));
      return;
    }

    setState('error', `代理异常退出（code=${code}）`, '详情见下方日志');
    if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'index.html'));
  });

  return true;
}

function stopProxy() {
  if (!proxyProc) return;
  const pid = proxyProc.pid;
  log('正在停止代理 pid=' + pid);
  try {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* ignore */ }
  proxyProc = null;
}

// ---------------- 启动流程 ----------------
async function waitReady(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await probe(800);
    if (r.ok) return r;
    await sleep(400);
  }
  return null;
}

let booting = false;

async function boot() {
  if (booting) return;
  booting = true;
  try {
    setState('starting', '正在检查代理状态…');

    const found = findProxy();
    if (found) {
      proxyScript = found.script;
      proxyDir = found.dir;
    }

    const cfg = readConfig();
    applyPort(cfg);

    const r = await probe(1200);
    if (r.ok) {
      ownsProxy = false;
      log(`检测到已在运行的代理 pid=${r.status && r.status.pid}`);
      setState('ready', '代理已就绪，正在加载控制台…');
      loadAdmin();
      return;
    }

    if (!proxyScript) {
      setState('error', '找不到 vertex_proxy.js', '请确认程序目录完整', true);
      return;
    }

    if (!resolveSaPath(cfg)) {
      log('未找到有效的服务账户文件');
      const sa = readSaInfo(cfg.saPath);
      setState('error', '需要完成首次配置', sa.error || '选择你自己的 SA 文件与端口（仅本机读取）', true);
      const hasConfig = fs.existsSync(configFile()) || (legacyConfigFile() && fs.existsSync(legacyConfigFile()));
      if (!hasConfig) {
        setTimeout(() => { if (!quitting) openSettings(); }, 700);
      }
      return;
    }

    log('未检测到运行中的代理，开始启动');
    if (!startProxy(cfg)) {
      setState('error', '代理启动失败', '查看下方日志', false);
      return;
    }

    setState('starting', '代理启动中，等待端口就绪…');
    const ready = await waitReady(30000);
    if (ready) {
      log(`代理就绪 pid=${ready.status && ready.status.pid}`);
      setState('ready', '代理已就绪，正在加载控制台…');
      loadAdmin();
    } else {
      setState('error', '代理启动超时（30 秒）', '检查上游代理与网络，或点「设置」确认配置', false);
    }
  } finally {
    booting = false;
  }
}

function loadAdmin() {
  if (!win || win.isDestroyed()) return;
  const current = win.webContents.getURL() || '';
  if (current.startsWith('http://127.0.0.1:')) return; // 已在控制台，交给页面自己重连
  setTimeout(() => {
    if (!win || win.isDestroyed() || quitting) return;
    win.loadURL(adminUrl);
  }, 260);
}

function openSettings() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'settings.html'));
}

function goBack() {
  if (!win || win.isDestroyed()) return;
  probe(800).then((r) => {
    if (r.ok) loadAdmin();
    else win.loadFile(path.join(__dirname, 'index.html'));
  });
}

// ---------------- 窗口 ----------------
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWinState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (s && Number(s.width) > 400 && Number(s.height) > 300) return s;
  } catch { /* 首次运行 */ }
  return { width: 1380, height: 900 };
}

let saveTimer = null;
function saveWinState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch { /* ignore */ }
  }, 400);
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const bounds = loadWinState();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#0b0f14',
    title: 'Vertex 代理控制台',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (tray) {
      try {
        tray.displayBalloon({
          title: 'Vertex 代理仍在后台运行',
          content: '双击托盘图标可重新打开控制台；菜单里可停止并退出。',
        });
      } catch { /* 部分系统不支持 */ }
    }
  });

  win.on('resize', saveWinState);
  win.on('move', saveWinState);

  // F5 / Ctrl+R 刷新页面
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (input.key === 'F5' || (input.control && key === 'r')) {
      win.webContents.reload();
      e.preventDefault();
    }
  });
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  } catch (e) {
    console.error('托盘创建失败', e);
    return;
  }
  tray.setToolTip('Vertex 代理控制台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制台', click: showWindow },
    { label: '在浏览器中打开', click: () => shell.openExternal(adminUrl) },
    { label: '设置…', click: () => { showWindow(); openSettings(); } },
    { type: 'separator' },
    {
      label: '停止代理并退出',
      click: () => { quitting = true; stopProxy(); app.quit(); },
    },
  ]));
  tray.on('double-click', showWindow);
}

// ---------------- IPC ----------------
ipcMain.handle('vx:hello', () => {
  const cfg = readConfig();
  return {
    state,
    log: logLines,
    config: {
      port: port,
      saPath: cfg.saPath || '',
      proxyScript: proxyScript,
      proxyHost: cfg.proxyHost || '127.0.0.1',
      proxyPort: cfg.proxyPort || 7897,
      useProxy: cfg.useProxy !== false,
      location: cfg.location || 'global',
    },
  };
});

ipcMain.handle('vx:settings-get', () => {
  const cfg = readConfig();
  const sa = readSaInfo(cfg.saPath || '');
  return {
    config: cfg,
    sa,
    defaults: { port: 8318, location: 'global', proxyHost: '127.0.0.1', proxyPort: 7897, useProxy: true },
    running: !!proxyProc,
  };
});

ipcMain.handle('vx:settings-save', (_e, input) => {
  const res = normalizeConfig(input || {});
  if (res.error) return { ok: false, error: res.error };

  if (!writeConfig(res.cfg)) return { ok: false, error: '写入配置失败，请查看日志' };

  log(`配置已保存：端口 ${res.cfg.port}，区域 ${res.cfg.location}，上游 ${res.cfg.useProxy ? res.cfg.proxyHost + ':' + res.cfg.proxyPort : '不使用'}`);
  applyPort(res.cfg);
  return { ok: true, config: res.cfg, projectId: res.sa.projectId };
});

ipcMain.handle('vx:choose-sa', async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择 Google 服务账户 JSON',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const p = r.filePaths[0];
    const info = readSaInfo(p);
    return { ok: true, path: p, projectId: info.projectId, clientEmail: info.clientEmail, valid: info.valid, error: info.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('vx:test-upstream', async (_e, host, tport) => {
  const h = String(host || '127.0.0.1').trim();
  const p = Number(tport) || 7897;
  const r = await testTcp(h, p);
  return { ...r, target: `${h}:${p}` };
});

ipcMain.on('vx:retry', () => { if (!quitting) boot(); });
ipcMain.on('vx:quit', () => { quitting = true; stopProxy(); app.quit(); });
ipcMain.on('vx:open-admin', () => shell.openExternal(adminUrl));
ipcMain.on('vx:open-settings', () => openSettings());
ipcMain.on('vx:back', () => goBack());

// ---------------- 生命周期 ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createTray();
    createWindow();
    boot();
  });

  app.on('window-all-closed', () => { /* 托盘常驻 */ });

  app.on('before-quit', () => { quitting = true; stopProxy(); });

  app.on('activate', () => showWindow());
}