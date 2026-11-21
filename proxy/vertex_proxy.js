/**
 * Vertex AI 代理（完整版）
 * 用服务账户 JSON 换 OAuth token，调 Vertex AI，对酒馆暴露 OpenAI 兼容接口（支持流式）。
 *
 * 用法: node vertex_proxy.js
 * 酒馆配置:
 *   来源: 自定义（兼容 OpenAI）
 *   Base URL: http://127.0.0.1:8318/v1
 *   API Key: 随便填
 *   模型: gemini-4-hydrogen / gemini-3.8-flash / ...
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

// ---------------- 配置 ----------------
const SA_PATH = process.env.VERTEX_SA || '';
const LOCATION = process.env.VERTEX_LOCATION || 'global';
const PORT = Number(process.env.VERTEX_PORT || 8318);
const PROXY_HOST = process.env.VERTEX_PROXY_HOST || '127.0.0.1';
const PROXY_PORT = Number(process.env.VERTEX_PROXY_PORT || 7897);
const USE_PROXY = process.env.VERTEX_NO_PROXY !== '1';

const MODELS = [
  'gemini-4-hydrogen',
  'gemini-4-carbon',
  'gemini-4-argon',
  'gemini-3.8-flash',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-think',
  'gemini-3.8-flash-nothink',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-think',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
];

// ---------------- 运行信息 / 日志缓冲（供 /admin 使用） ----------------
const VERSION = '1.1.0';
const START_TIME = Date.now();
const ADMIN_HTML = path.join(__dirname, 'vertex_proxy_admin.html');

const LOG_CAP = 800;
const logs = [];
const logClients = new Set();
let logSeq = 0;

function guessLevel(text) {
  if (/^\[(fatal|err|error)\b/i.test(text)) return 'error';
  if (/^\[warn\b/i.test(text)) return 'warn';
  return 'info';
}

function pushLog(level, text) {
  const item = { id: ++logSeq, t: Date.now(), level, text: String(text) };
  logs.push(item);
  if (logs.length > LOG_CAP) logs.shift();
  if (logClients.size) {
    const line = `data: ${JSON.stringify(item)}\n\n`;
    for (const c of logClients) {
      try { c.write(line); } catch { logClients.delete(c); }
    }
  }
  return item;
}

// 包装 console：保留原有输出，同时进环形缓冲 + SSE 广播
for (const name of ['log', 'info', 'warn', 'error']) {
  const orig = console[name].bind(console);
  console[name] = (...args) => {
    orig(...args);
    try {
      const text = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
      const level = name === 'warn' ? 'warn' : (name === 'error' ? 'error' : guessLevel(text));
      pushLog(level, text);
    } catch { /* 日志失败不能影响主流程 */ }
  };
}

const stats = {
  requests: 0, streams: 0, errors: 0,
  tokensIn: 0, tokensOut: 0, cacheHits: 0,
  lastRequestAt: 0, lastErrorAt: 0, lastError: '',
};

function tokenState() {
  const now = Math.floor(Date.now() / 1000);
  const exp = tokenCache.exp || 0;
  return {
    valid: !!tokenCache.token && exp > now,
    expiresIn: Math.max(0, exp - now),
    expAt: exp ? exp * 1000 : 0,
  };
}

function isLocalReq(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

function statusPayload(req) {
  return {
    ok: true,
    version: VERSION,
    pid: process.pid,
    port: PORT,
    host: '0.0.0.0',
    project: PROJECT,
    location: LOCATION,
    sa: SA_PATH,
    proxy: USE_PROXY ? `${PROXY_HOST}:${PROXY_PORT}` : null,
    upstream: vertexHost(),
    startedAt: START_TIME,
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    local: isLocalReq(req),
    token: tokenState(),
    stats,
    cache: { enabled: CACHE_ENABLED, size: cacheStore.size, ttl: CACHE_TTL, minTokens: CACHE_MIN_TOKENS },
    models: MODELS,
    logCount: logSeq,
  };
}

// ---------------- 服务账户 / token ----------------
if (!SA_PATH) {
  console.error('[fatal] 未指定服务账户文件：请在桌面端设置页选择，或设置环境变量 VERTEX_SA 指向服务账户 JSON');
  process.exit(1);
}
if (!fs.existsSync(SA_PATH)) {
  console.error(`[fatal] 找不到服务账户文件: ${SA_PATH}`);
  process.exit(1);
}
const SA = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
const PROJECT = SA.project_id;

let tokenCache = { token: null, exp: 0 };
let refreshing = null;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJWT() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({
    iss: SA.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: SA.token_uri,
    exp: now + 3600,
    iat: now,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  return `${h}.${p}.${b64url(signer.sign(SA.private_key))}`;
}

// ---------------- HTTPS（可走 HTTP 代理）----------------
function httpsRequest(host, pathname, method, headers, body) {
  return new Promise((resolve, reject) => {
    const doRequest = (createConnection) => {
      const req = https.request({
        host, path: pathname, method, headers,
        ...(createConnection ? { createConnection } : {}),
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };

    if (!USE_PROXY) return doRequest(null);

    const connectReq = http.request({
      host: PROXY_HOST, port: PROXY_PORT, method: 'CONNECT', path: `${host}:443`,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('代理 CONNECT 失败: ' + res.statusCode));
      const tlsSocket = tls.connect({ socket, servername: host }, () => doRequest(() => tlsSocket));
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

/** 流式 HTTPS（SSE） */
function httpsStream(host, pathname, method, headers, body, onChunk) {
  return new Promise((resolve, reject) => {
    const doRequest = (createConnection) => {
      const req = https.request({
        host, path: pathname, method, headers,
        ...(createConnection ? { createConnection } : {}),
      }, (res) => {
        let buf = '';
        let errBody = '';
        let parseFail = 0;
        let chunkCount = 0;
        let lastFinish = '';
        res.on('data', (chunk) => {
          const s = chunk.toString('utf8');
          // 非 200 时收集原始错误体
          if (res.statusCode !== 200) { errBody += s; return; }
          buf += s;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '').trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              chunkCount++;
              // 整体拒绝（整个 prompt 被判违规，没有 candidates）
              const pf = parsed.promptFeedback;
              if (pf && pf.blockReason) {
                lastFinish = 'BLOCKED_' + pf.blockReason;
              }
              const fr = parsed.candidates?.[0]?.finishReason;
              if (fr) lastFinish = fr;
              onChunk(parsed);
            } catch {
              parseFail++;
            }
          }
        });
        res.on('end', () => {
          // 处理缓冲区里的最后一行（没有以 \n 结尾时）
          const tail = buf.trim();
          if (tail.startsWith('data:')) {
            const payload = tail.slice(5).trim();
            if (payload && payload !== '[DONE]') {
              try {
                const parsed = JSON.parse(payload);
                chunkCount++;
                const pf = parsed.promptFeedback;
                if (pf && pf.blockReason) lastFinish = 'BLOCKED_' + pf.blockReason;
                const fr = parsed.candidates?.[0]?.finishReason;
                if (fr) lastFinish = fr;
                onChunk(parsed);
              } catch { parseFail++; }
            }
          }
          resolve({ status: res.statusCode, body: errBody, stats: { chunkCount, parseFail, lastFinish } });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };

    if (!USE_PROXY) return doRequest(null);

    const connectReq = http.request({
      host: PROXY_HOST, port: PROXY_PORT, method: 'CONNECT', path: `${host}:443`,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('代理 CONNECT 失败: ' + res.statusCode));
      const tlsSocket = tls.connect({ socket, servername: host }, () => doRequest(() => tlsSocket));
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

async function getToken(force = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && tokenCache.token && tokenCache.exp > now + 120) return tokenCache.token;
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const jwt = makeJWT();
    const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`;
    const u = new URL(SA.token_uri);
    const res = await httpsRequest(u.hostname, u.pathname, 'POST',
      { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      body);
    if (res.status !== 200) throw new Error(`token ${res.status}: ${res.body.slice(0, 200)}`);
    const j = JSON.parse(res.body);
    tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
    console.log(`[token] 已刷新，${j.expires_in}s 后过期`);
    return tokenCache.token;
  })();

  try { return await refreshing; } finally { refreshing = null; }
}

// ---------------- 上下文缓存（Vertex explicit caching）----------------
const cacheStore = new Map();  // hash -> { name, exp }
const CACHE_TTL = '3600s';
const CACHE_MIN_TOKENS = 4096;
const CACHE_ENABLED = !process.env.VERTEX_NO_CACHE && process.env.VERTEX_CACHE === '1';

function roughTokens(s) {
  // 中文约 1.5 字/token，其它约 4 字符/token
  let cn = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) cn++;
  }
  return Math.floor(cn / 1.5 + (s.length - cn) / 4);
}

/** 用 systemText 做前缀，创建/复用缓存。返回 cache 名或 null */
async function getOrCreateCache(model, systemText) {
  if (!CACHE_ENABLED) return null;
  if (!systemText || roughTokens(systemText) < CACHE_MIN_TOKENS) return null;

  const hash = crypto.createHash('sha256').update(model + '\u0000' + systemText).digest('hex').slice(0, 24);
  const hit = cacheStore.get(hash);
  if (hit && hit.exp > Date.now()) return hit.name;

  const token = await getToken();
  const host = vertexHost();
  const payload = JSON.stringify({
    model: `projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${model}`,
    contents: [{ role: 'user', parts: [{ text: systemText }] }],
    ttl: CACHE_TTL,
  });

  const r = await httpsRequest(host, `/v1/projects/${PROJECT}/locations/${LOCATION}/cachedContents`, 'POST', {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  }, payload);

  if (r.status !== 200) {
    console.log(`[cache] 创建失败 ${r.status}: ${r.body.slice(0, 150)}`);
    return null;
  }

  const j = JSON.parse(r.body);
  cacheStore.set(hash, { name: j.name, exp: Date.now() + 3500 * 1000 });
  console.log(`[cache] 已创建 ${j.usageMetadata?.totalTokenCount || '?'} tokens  (共 ${cacheStore.size} 个)`);
  return j.name;
}

// ---------------- 请求转换 ----------------
function toVertexPayload(reqBody, model) {
  const contents = [];
  let systemInstruction = null;

  for (const m of reqBody.messages || []) {
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map(p => (typeof p === 'string' ? p : (p.text || '')))
        .filter(Boolean)
        .join('\n');
    } else if (m.content != null) {
      text = JSON.stringify(m.content);
    }

    // 空消息直接跳过（否则 Vertex 会报 "parts.data must have one initialized field"）
    if (!text || !text.trim()) continue;

    if (m.role === 'system') {
      systemInstruction = systemInstruction
        ? { parts: [...systemInstruction.parts, { text }] }
        : { parts: [{ text }] };
      continue;
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }

  const gen = {
    temperature: reqBody.temperature ?? 1,
    topP: reqBody.top_p ?? 0.95,
    maxOutputTokens: reqBody.max_tokens ?? 8192,
  };
  if (reqBody.stop) gen.stopSequences = Array.isArray(reqBody.stop) ? reqBody.stop : [reqBody.stop];

  // Gemini 要求 contents 的 role 交替（user/model），连续同角色必须合并
  const merged = [];
  for (const c of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) {
      last.parts.push(...c.parts);
    } else {
      merged.push({ role: c.role, parts: [...c.parts] });
    }
  }
  // 兜底：某些客户端会把全部消息都标成 system，导致 contents 为空（Vertex 报 400）
  if (merged.length === 0 && systemInstruction) {
    const sysText = systemInstruction.parts.map(p => p.text || '').join('\n');
    merged.push({ role: 'user', parts: [{ text: sysText }] });
    systemInstruction = null;
    console.log('[compat] 全部消息都是 system，已折叠为单条 user 发送');
  }

  // 首条必须是 user
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: '（继续）' }] });
  }

  const out = { contents: merged, generationConfig: gen };

  // 思考预算控制
  // 3.x 用 thinkingBudget（数字）；4.x 用 thinkingLevel（low/medium/high）
  // 档位：-nothink | -low(默认) | -think(高)
  const baseModel = model.replace(/-(no)?(think|low)$/i, '');
  const isV4 = /^gemini-4-/i.test(baseModel);

  if (isV4) {
    let level = 'low';  // 默认 low（预设要求）
    if (/-nothink$/i.test(model)) level = 'low';   // 4.x 最低就是 low
    else if (/-low$/i.test(model)) level = 'low';
    else if (/-think$/i.test(model)) level = 'high';
    else if (process.env.VERTEX_THINK === '1') level = 'high';
    out.generationConfig.thinkingConfig = { thinkingLevel: level };
  } else {
    let budget = 1024;  // 默认 low
    if (typeof reqBody.thinking_budget === 'number') budget = reqBody.thinking_budget;
    else if (/-nothink$/i.test(model)) budget = 0;
    else if (/-low$/i.test(model)) budget = 1024;
    else if (/-think$/i.test(model)) budget = null;
    else if (process.env.VERTEX_THINK === '1') budget = null;
    else if (process.env.VERTEX_THINK === '0') budget = 0;

    if (budget !== null) {
      out.generationConfig.thinkingConfig = { thinkingBudget: budget };
    }
  }

  if (systemInstruction) out.systemInstruction = systemInstruction;

  // 强制禁止函数调用（防止模型模仿预设里提到的 soliumbra_reply 等工具）
  // 否则会出现 finish=MALFORMED_FUNCTION_CALL 导致空回复
  out.toolConfig = { functionCallingConfig: { mode: 'NONE' } };

  // 附带纯文本的 system 内容，供上下文缓存使用
  const systemText = systemInstruction ? systemInstruction.parts.map(p => p.text || '').join('\n') : '';

  return { payload: out, systemText };
}

function vertexPath(model, stream) {
  const suffix = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${model}:${suffix}`;
}

function vertexHost() {
  return LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
}

// ---------------- HTTP 服务 ----------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ---------------- 管理接口（/admin 与 /api/*） ----------------
const sockets = new Set();

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function handleAdmin(req, res, urlObj) {
  const p = urlObj.pathname;

  if (p === '/admin' || p === '/admin/' || p === '/admin/index.html') {
    try {
      sendHtml(res, 200, fs.readFileSync(ADMIN_HTML, 'utf8'));
    } catch (e) {
      sendHtml(res, 500, `<!doctype html><meta charset="utf-8"><h2>管理页面缺失</h2><p>找不到 ${ADMIN_HTML}</p><p>${e.message}</p>`);
    }
    return true;
  }

  if (p === '/api/status') {
    sendJson(res, 200, statusPayload(req));
    return true;
  }

  if (p === '/api/models') {
    sendJson(res, 200, {
      object: 'list',
      total: MODELS.length,
      data: MODELS.map(id => ({ id, object: 'model', owned_by: 'google' })),
    });
    return true;
  }

  if (p === '/api/logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    for (const item of logs) res.write(`data: ${JSON.stringify(item)}\n\n`);
    logClients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(ping); logClients.delete(res); }
    }, 15000);
    req.on('close', () => { clearInterval(ping); logClients.delete(res); });
    return true;
  }

  if (p === '/api/token/refresh') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '需要 POST' });
      return true;
    }
    if (!isLocalReq(req)) {
      sendJson(res, 403, { error: '仅限本机操作' });
      return true;
    }
    pushLog('info', '[admin] 手动刷新 token…');
    getToken(true)
      .then(() => {
        pushLog('info', '[admin] token 刷新成功');
        sendJson(res, 200, { ok: true, token: tokenState() });
      })
      .catch(e => {
        pushLog('warn', '[admin] token 刷新失败: ' + e.message);
        sendJson(res, 502, { ok: false, error: e.message, token: tokenState() });
      });
    return true;
  }

  if (p === '/api/stop' || p === '/api/restart') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '需要 POST' });
      return true;
    }
    if (!isLocalReq(req)) {
      sendJson(res, 403, { error: '仅限本机操作' });
      return true;
    }
    const restart = p === '/api/restart';
    sendJson(res, 200, { ok: true, action: restart ? 'restart' : 'stop' });
    pushLog('warn', restart ? '[admin] 收到重启指令' : '[admin] 收到停止指令');
    setTimeout(() => { restart ? restartSelf() : shutdown('admin'); }, 350);
    return true;
  }

  if (p.startsWith('/api/')) {
    sendJson(res, 404, { error: '未知接口: ' + p });
    return true;
  }

  return false;
}

function hardClose(cb) {
  let done = false;
  const finish = () => { if (done) return; done = true; cb(); };
  try { server.close(finish); } catch { finish(); }
  for (const s of sockets) { try { s.destroy(); } catch {} }
  setTimeout(finish, 900);
}

function shutdown(why) {
  pushLog('warn', `[admin] 代理正在停止（${why || 'manual'}）`);
  hardClose(() => process.exit(0));
  setTimeout(() => process.exit(0), 1800);
}

function restartSelf() {
  // 不自我 fork：交给启动脚本（start_vertex.bat / 桌面 bat）按退出码 75 重新拉起，
  // 这样日志仍留在同一个控制台窗口，也避免后台任务里 detached 子进程被杀。
  pushLog('warn', '[admin] 请求重启：进程退出（码 75），等待启动脚本拉起');
  process.exitCode = 75;
  hardClose(() => {
    setTimeout(() => process.exit(75), 120);
  });
  setTimeout(() => process.exit(75), 2000);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    return res.end();
  }

  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', async () => {
    try {
      let urlObj = null;
      try { urlObj = new URL(req.url, 'http://127.0.0.1'); } catch { /* 非法 URL 走原逻辑 */ }
      if (urlObj && handleAdmin(req, res, urlObj)) return;

      if (req.url === '/' || req.url === '/health') {
        return sendJson(res, 200, {
          ok: true, project: PROJECT, location: LOCATION,
          proxy: USE_PROXY ? `${PROXY_HOST}:${PROXY_PORT}` : 'off',
          models: MODELS.length,
        });
      }

      if (req.url.startsWith('/v1/models')) {
        return sendJson(res, 200, {
          object: 'list',
          data: MODELS.map(id => ({ id, object: 'model', owned_by: 'google' })),
        });
      }

      if (!req.url.startsWith('/v1/chat/completions')) {
        return sendJson(res, 404, { error: { message: 'not found: ' + req.url } });
      }

      const reqBody = JSON.parse(raw || '{}');
      const model = reqBody.model || 'gemini-3.8-flash';
      stats.requests++;
      stats.lastRequestAt = Date.now();
      // 剥掉控制后缀，实际发给 Vertex 的模型名
      const apiModel = model.replace(/-(no)?(think|low)$/i, '');
      const wantStream = !!reqBody.stream;
      if (wantStream) stats.streams++;
      const { payload, systemText } = toVertexPayload(reqBody, model);
      const token = await getToken();
      const host = vertexHost();
      const pathname = vertexPath(apiModel, wantStream);

      // 尝试用 system 内容做上下文缓存（能省 75% 输入成本）
      // 关键：只在缓存已存在时同步使用；不存在则后台创建，绝不阻塞正文请求
      let cacheName = null;
      try {
        if (CACHE_ENABLED && systemText && roughTokens(systemText) >= CACHE_MIN_TOKENS) {
          const hash = crypto.createHash('sha256').update(apiModel + '\u0000' + systemText).digest('hex').slice(0, 24);
          const hit = cacheStore.get(hash);
          if (hit && hit.exp > Date.now()) {
            cacheName = hit.name;
          } else {
            // 后台创建，不 await
            getOrCreateCache(apiModel, systemText).catch(e => {
              console.log('[cache] 后台创建失败:', e.message.slice(0, 60));
            });
          }
        }
      } catch (e) {
        console.log('[cache] 异常:', e.message.slice(0, 80));
      }
      if (cacheName) {
        payload.cachedContent = cacheName;
        delete payload.systemInstruction;  // 已在缓存里
        stats.cacheHits++;
        console.log(`[cache] 命中复用，system ${roughTokens(systemText)} tok 走缓存`);
      }

      console.log(`[req] ${model}${apiModel !== model ? ' -> ' + apiModel : ''} msgs=${(reqBody.messages || []).length} stream=${wantStream}`);

      // 诊断：contents 为空时打印消息结构（定位后可删）
      if (!payload.contents || payload.contents.length === 0) {
        const sample = (reqBody.messages || []).slice(0, 3).map(m => ({
          role: m.role,
          type: typeof m.content,
          len: typeof m.content === 'string' ? m.content.length : (Array.isArray(m.content) ? m.content.length : -1),
          head: typeof m.content === 'string' ? m.content.slice(0, 60) : JSON.stringify(m.content).slice(0, 60),
        }));
        console.log('[diag] contents 为空; keys=' + Object.keys(reqBody).join(',') + ' sample=' + JSON.stringify(sample));
      }

      if (!wantStream) {
        let payloadJson = JSON.stringify(payload);
        let r = await httpsRequest(host, pathname, 'POST', {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadJson),
        }, payloadJson);

        // 某些模型不支持 thinkingBudget，自动回退重试
        if (r.status === 400 && /Thinking budget is not supported/i.test(r.body) && payload.generationConfig?.thinkingConfig) {
          console.log('[retry] 该模型不支持 thinkingBudget，去掉后重试');
          const p2 = JSON.parse(JSON.stringify(payload));
          delete p2.generationConfig.thinkingConfig;
          payloadJson = JSON.stringify(p2);
          r = await httpsRequest(host, pathname, 'POST', {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payloadJson),
          }, payloadJson);
        }

        if (r.status !== 200) {
          stats.errors++;
          stats.lastErrorAt = Date.now();
          stats.lastError = `${r.status} ${r.body.slice(0, 120)}`;
          console.log(`[err] ${r.status} ${r.body.slice(0, 200)}`);
          return sendJson(res, r.status, { error: { message: r.body } });
        }

        const vj = JSON.parse(r.body);
        const cand = (vj.candidates || [])[0] || {};
        const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
        const finish = cand.finishReason || 'STOP';
        stats.tokensIn += vj.usageMetadata?.promptTokenCount || 0;
        stats.tokensOut += vj.usageMetadata?.candidatesTokenCount || 0;

        return sendJson(res, 200, {
          id: 'chatcmpl-' + crypto.randomUUID(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: finish === 'STOP' ? 'stop' : (finish === 'MAX_TOKENS' ? 'length' : String(finish).toLowerCase()),
          }],
          usage: {
            prompt_tokens: vj.usageMetadata?.promptTokenCount ?? 0,
            completion_tokens: vj.usageMetadata?.candidatesTokenCount ?? 0,
            total_tokens: vj.usageMetadata?.totalTokenCount ?? 0,
          },
        });
      }

      // 流式
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const id = 'chatcmpl-' + crypto.randomUUID();
      const created = Math.floor(Date.now() / 1000);

      let streamUsage = null;
      const r = await httpsStream(host, pathname, 'POST', {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
      }, JSON.stringify(payload), (chunk) => {
        if (chunk.usageMetadata) streamUsage = chunk.usageMetadata;
        const parts = ((chunk.candidates || [])[0]?.content?.parts) || [];
        const piece = parts.map(p => p.text || '').join('');
        if (!piece) return;
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        })}\n\n`);
      });
      if (streamUsage) {
        stats.tokensIn += streamUsage.promptTokenCount || 0;
        stats.tokensOut += streamUsage.candidatesTokenCount || 0;
      }

      if (r.status !== 200) {
        let detail = `upstream ${r.status}`;
        try {
          const ej = JSON.parse(r.body);
          detail = `upstream ${r.status}: ` + (ej.error?.message || r.body).slice(0, 300);
        } catch {
          detail = `upstream ${r.status}: ` + r.body.slice(0, 300);
        }
        stats.errors++;
        stats.lastErrorAt = Date.now();
        stats.lastError = detail.slice(0, 160);
        console.log('[err-stream]', detail);
        res.write(`data: ${JSON.stringify({ error: { message: detail } })}\n\n`);
      } else if (r.stats) {
        console.log(`[stream-done] chunks=${r.stats.chunkCount} parseFail=${r.stats.parseFail} finish=${r.stats.lastFinish || '?'}`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      console.log('[fatal]', e.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
      else res.end();
    }
  });
});

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

let listenRetries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenRetries < 5) {
    listenRetries++;
    console.log(`[warn] 端口 ${PORT} 被占用，1 秒后重试（${listenRetries}/5）`);
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 1000);
    return;
  }
  console.error('[fatal] 服务启动失败: ' + (err.message || err));
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log('==============================================');
  console.log(` Vertex AI 代理已启动  v${VERSION}`);
  console.log(`   地址:   http://127.0.0.1:${PORT}/v1`);
  console.log(`   管理:   http://127.0.0.1:${PORT}/admin`);
  console.log(`   项目:   ${PROJECT}`);
  console.log(`   地区:   ${LOCATION}`);
  console.log(`   代理:   ${USE_PROXY ? PROXY_HOST + ':' + PROXY_PORT : '不使用'}`);
  console.log(`   模型:   ${MODELS.length} 个`);
  console.log('==============================================');
  try {
    await getToken();
    console.log('[ready] 可以用了');
  } catch (e) {
    console.log('[warn] token 获取失败:', e.message);
    console.log('[warn] 检查随云代理是否连上，然后重启本脚本');
  }
});
