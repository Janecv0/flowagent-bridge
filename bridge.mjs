#!/usr/bin/env node
// Per-user stdio -> streamable-HTTP bridge for the Power Automate (FlowAgent) MCP server.
//
// WHY THIS EXISTS: the FlowAgent engine only speaks stdio, and it authenticates by
// shelling out to the Azure CLI (`az account get-access-token`) — it has no code path
// that accepts a bearer token supplied per request. LibreChat therefore cannot run it
// as a `type: stdio` server (its container has no `az`), and cannot authenticate it as
// an OAuth resource server either. This process fronts the engine over HTTP instead.
//
// WHY PER-USER: Power Automate connections execute as their owner regardless of who
// triggers them, and environment-admin visibility exposes any flow's run data. A single
// shared identity would let any LibreChat user act on, and read the data of, every other
// employee's automation. Each user therefore gets their own engine process with its own
// AZURE_CONFIG_DIR, so `az` operates against that person's own login and their own real
// Power Automate permissions.
//
// This is a transport-level proxy: JSON-RPC frames pass through verbatim except for the
// three interceptions in `forwardToClient`/`forwardToEngine` (synthetic connect tool,
// auth-error rewriting), so new engine tools appear without touching this file.

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, access } from 'node:fs/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// PORT first: Railway (and most PaaS) assign the port they route and health-check on via
// PORT, and a service listening anywhere else just looks dead. FLOWAGENT_BRIDGE_PORT stays
// supported for local runs where PORT is often already taken by something else.
//
// Railway injects PORT automatically, so it silently overrides FLOWAGENT_BRIDGE_PORT there.
// That is the right precedence — the health check follows PORT — but it is confusing enough
// to have cost a deploy, so PORT_SOURCE is logged at startup.
const PORT = Number(process.env.PORT || process.env.FLOWAGENT_BRIDGE_PORT || 8791);
const PORT_SOURCE = process.env.PORT
  ? 'PORT'
  : process.env.FLOWAGENT_BRIDGE_PORT
    ? 'FLOWAGENT_BRIDGE_PORT'
    : 'default';
// Default to '::' (dual-stack) because Railway's private network is IPv6-only — a
// service bound to 0.0.0.0 is unreachable over *.railway.internal. Local dev overrides
// this to the docker0 address so the unauthenticated dev mode isn't exposed to the LAN.
const HOST = process.env.FLOWAGENT_BRIDGE_HOST || '::';
const USERS_ROOT = process.env.USERS_ROOT || '/data/pa-users';
const SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET || '';
const TENANT_ID = process.env.AZURE_TENANT_ID || process.env.PA_TENANT_ID || '';
const LAUNCHER = new URL('./launch.mjs', import.meta.url).pathname;

// Presence of the shared secret is what distinguishes deployed from local-dev operation.
// In production the bridge fails closed on identity; in dev it falls back to one shared
// directory so the zero-config local flow keeps working.
const PRODUCTION = SHARED_SECRET.length > 0;

const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS || 30 * 60 * 1000);
const REAPER_INTERVAL_MS = 60 * 1000;
// az's device code is valid ~15 minutes; give the process a minute of grace past that
// before assuming it will never complete.
const LOGIN_MAX_MS = 16 * 60 * 1000;
const LOGIN_FIRST_OUTPUT_MS = 5000;

const CONNECT_TOOL = 'power_automate_connect_account';
/** Dev-only stand-in identity used when no user header is present. See `engineEnv`. */
const SHARED_DEV_USER = '_shared';

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Structured per-tool-call audit line. Who did what, under which Azure identity. */
const audit = (entry) => console.log(JSON.stringify({ type: 'audit', ...entry }));

/** sessionId -> { http, stdio, userId, lastActivity } */
const sessions = new Map();
/** userId -> { proc, output, startedAt } — in-flight `az login` per user. */
const logins = new Map();

/**
 * LibreChat user ids are Mongo ObjectIds. This value becomes a filesystem path
 * component under a shared volume, so it is allowlisted rather than escaped.
 */
const isValidUserId = (value) => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);

const userDir = (userId) => path.join(USERS_ROOT, userId);

/**
 * Provisioning is lazy — a user's directory appears on first use, so there is no separate
 * onboarding step. Skipped entirely in dev mode, where engine children use the host's
 * own ~/.azure and USERS_ROOT (default /data/pa-users) would not even be writable.
 */
async function ensureUserDir(userId) {
  if (!PRODUCTION) return;
  await mkdir(userDir(userId), { recursive: true });
}

/**
 * Engine children get an explicit env, never the bridge's own. Inheriting would leak
 * BRIDGE_SHARED_SECRET into a subprocess that has no use for it, and — more importantly —
 * would let the bridge's own HOME/AZURE_CONFIG_DIR leak in and silently defeat the
 * per-user isolation this whole design exists for.
 *
 * Dev mode is the deliberate exception: every session points at the developer's real
 * `~/.azure`, so a local `az login` keeps working exactly as it did before per-user
 * isolation existed. This applies regardless of the user id, because LibreChat does send
 * a real one locally — isolating on it would force each developer account through a
 * device-code login against an empty directory, which is production behavior imposed on
 * a single-user machine. Production never takes this branch.
 */
function engineEnv(userId) {
  const isHostDeveloper = !PRODUCTION;
  const dir = isHostDeveloper ? path.join(process.env.HOME ?? '', '.azure') : userDir(userId);
  const home = isHostDeveloper ? (process.env.HOME ?? '') : userDir(userId);
  return {
    PATH: process.env.PATH,
    HOME: home,
    AZURE_CONFIG_DIR: dir,
    FLOWAGENT_MSAL_CACHE_DIR: dir,
    FLOWAGENT_TOKEN_CACHE_DIR: dir,
    ...(TENANT_ID ? { PA_TENANT_ID: TENANT_ID } : {}),
    ...(process.env.PA_CLIENT_ID ? { PA_CLIENT_ID: process.env.PA_CLIENT_ID } : {}),
    ...(process.env.PA_DEFAULT_ENVIRONMENT
      ? { PA_DEFAULT_ENVIRONMENT: process.env.PA_DEFAULT_ENVIRONMENT }
      : {}),
  };
}

function closeSession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  sessions.delete(id);
  entry.stdio.close().catch(() => {});
  entry.http.close().catch(() => {});
  log(`session ${id} closed (${sessions.size} active)`);
}

// ---------------------------------------------------------------------------
// Message interception
// ---------------------------------------------------------------------------

const connectToolDescriptor = {
  name: CONNECT_TOOL,
  description:
    'Connect your Power Automate account. Returns a short code and a link to open in ' +
    'your browser. Use this when Power Automate tools report that you are not signed in.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Connect Power Automate Account', readOnlyHint: false },
};

/**
 * The engine reports auth failures as human text telling the user to run `az login`,
 * which is meaningless in a chat UI with no shell. Matching is on message substrings
 * rather than a structured code because the engine does not serialize its
 * AzCliAuthError `.code` onto the wire — only the message text reaches us.
 */
const AUTH_REWRITES = [
  {
    match: /signed in to azure|run this command to sign in|please run ['"]?az login/i,
    text: `You are not connected to Power Automate yet. Run the "${CONNECT_TOOL}" tool to connect your account.`,
  },
  {
    match: /session has expired/i,
    text: `Your Power Automate session has expired. Run the "${CONNECT_TOOL}" tool to sign in again.`,
  },
  {
    // Distinct on purpose: these users ARE signed in, they lack a license or rights.
    // Sending them to the connect tool would loop them through a login that changes nothing.
    match: /power automate license|does not have access|doesn't have access|permission-denied/i,
    text: 'Your account is signed in but lacks Power Automate access. Contact IT about your Power Automate license or environment permissions.',
  },
  {
    // Means the container image is broken, not that the user did anything wrong.
    match: /azure cli is not installed/i,
    text: 'The Power Automate integration is misconfigured on the server. Please report this to the LibreChat administrator.',
    serverBug: true,
  },
];

function rewriteAuthText(original) {
  for (const rule of AUTH_REWRITES) {
    if (rule.match.test(original)) return rule;
  }
  return null;
}

/** Rewrites auth-shaped tool errors in place; returns the (possibly modified) message. */
function interceptEngineResult(msg) {
  const content = msg?.result?.content;
  if (!msg?.result?.isError || !Array.isArray(content)) return msg;

  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const rule = rewriteAuthText(part.text);
    if (!rule) {
      if (/\baz\b|azure|sign in|token/i.test(part.text)) {
        log('[auth-rewrite] unmatched auth-shaped error, wording may have changed:', part.text.slice(0, 200));
      }
      continue;
    }
    if (rule.serverBug) log('[server-bug]', part.text.slice(0, 300));
    part.text = `${rule.text}\n\n(Original error: ${part.text})`;
  }
  return msg;
}

/** Appends the bridge-provided connect tool to the engine's tools/list response. */
function interceptToolsList(msg) {
  if (!Array.isArray(msg?.result?.tools)) return msg;
  if (msg.result.tools.some((tool) => tool?.name === CONNECT_TOOL)) return msg;
  msg.result.tools.push(connectToolDescriptor);
  return msg;
}

// ---------------------------------------------------------------------------
// Device-code login
// ---------------------------------------------------------------------------

/**
 * Starts `az login --use-device-code` for a user and returns whatever it has printed
 * so far. The process is detached and NOT awaited: device-code login blocks for up to
 * ~15 minutes polling for the browser step, far longer than an MCP tool call can wait.
 * Output is buffered per user so a retry can read the code even if it printed after the
 * first call returned, and so a second concurrent call reuses the same login rather than
 * racing another `az` process against the same token cache.
 */
async function connectAccount(userId) {
  const existing = logins.get(userId);
  if (existing) {
    const waited = Date.now() - existing.startedAt;
    const captured = existing.output.trim();
    if (captured) return `${captured}\n\n(Sign-in already in progress — complete the step above.)`;
    return `Sign-in is starting (${Math.round(waited / 1000)}s). Run this tool again in a few seconds to get your code.`;
  }

  await ensureUserDir(userId);

  const args = ['login', '--use-device-code'];
  if (TENANT_ID) args.push('--tenant', TENANT_ID);

  const proc = spawn('az', args, { env: engineEnv(userId), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { proc, output: '', startedAt: Date.now() };
  logins.set(userId, entry);

  // az prints the device code to stderr and the account JSON to stdout on success.
  const collect = (chunk) => {
    entry.output += String(chunk);
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);

  proc.on('exit', (code) => {
    log(`[login] user=${userId} az exited code=${code}`);
    logins.delete(userId);
  });
  proc.on('error', (err) => {
    log(`[login] user=${userId} az failed to start: ${err.message}`);
    entry.output += `\nFailed to start Azure CLI: ${err.message}`;
  });

  const firstOutput = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(entry.output), LOGIN_FIRST_OUTPUT_MS);
    const check = () => {
      if (!entry.output.trim()) return;
      clearTimeout(timer);
      proc.stderr.off('data', check);
      proc.stdout.off('data', check);
      // Let the rest of the line arrive before reading — the code and URL are one message.
      setTimeout(() => resolve(entry.output), 250);
    };
    proc.stderr.on('data', check);
    proc.stdout.on('data', check);
  });

  const text = firstOutput.trim();
  if (!text) {
    return 'Sign-in is starting. Run this tool again in a few seconds to get your code and link.';
  }
  return `${text}\n\nOpen the link above, enter the code, and sign in with your work account. Then just ask for your Power Automate flows again — no need to re-run this tool.`;
}

function reapStaleLogins() {
  const now = Date.now();
  for (const [userId, entry] of logins) {
    if (now - entry.startedAt < LOGIN_MAX_MS) continue;
    log(`[login] user=${userId} device code expired, killing az`);
    try {
      process.kill(-entry.proc.pid);
    } catch {
      try {
        entry.proc.kill();
      } catch {}
    }
    logins.delete(userId);
  }
}

function reapIdleSessions() {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastActivity < SESSION_IDLE_MS) continue;
    log(`[reaper] session ${id} idle > ${Math.round(SESSION_IDLE_MS / 60000)}min, closing`);
    closeSession(id);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * One engine child per MCP session — deliberately not pooled per user. The engine holds
 * mutable current-environment/current-flow state (`set_current_env`, `set_current_flow`),
 * so two chats sharing one process would silently reassign each other's working context.
 * Idle reaping bounds the memory cost instead (~75 MB per live child).
 */
async function createSession(userId) {
  await ensureUserDir(userId);

  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [LAUNCHER],
    env: engineEnv(userId),
    stderr: 'pipe',
  });

  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { http: httpTransport, stdio, userId, lastActivity: Date.now() });
      log(`session ${id} initialized for user=${userId} (${sessions.size} active)`);
    },
  });

  const pending = new Map();

  const forwardToEngine = async (msg) => {
    if (msg?.method === 'tools/call' && msg?.params?.name === CONNECT_TOOL) {
      const started = Date.now();
      let text;
      let ok = true;
      try {
        text = await connectAccount(userId);
      } catch (err) {
        ok = false;
        text = `Could not start sign-in: ${err.message}`;
      }
      audit({ userId, tool: CONNECT_TOOL, durationMs: Date.now() - started, ok });
      await httpTransport.send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text }], isError: !ok },
      });
      return;
    }

    if (msg?.method === 'tools/call' && msg?.id != null) {
      pending.set(msg.id, { tool: msg.params?.name, started: Date.now() });
    }
    await stdio.send(msg);
  };

  const forwardToClient = async (msg) => {
    if (msg?.id != null && pending.has(msg.id)) {
      const { tool, started } = pending.get(msg.id);
      pending.delete(msg.id);
      audit({ userId, tool, durationMs: Date.now() - started, ok: !msg?.result?.isError });
    }
    await httpTransport.send(interceptToolsList(interceptEngineResult(msg)));
  };

  httpTransport.onmessage = (msg) => forwardToEngine(msg).catch((e) => log('-> engine failed:', e.message));
  stdio.onmessage = (msg) => forwardToClient(msg).catch((e) => log('<- client failed:', e.message));

  httpTransport.onclose = () => httpTransport.sessionId && closeSession(httpTransport.sessionId);
  stdio.onclose = () => httpTransport.sessionId && closeSession(httpTransport.sessionId);
  stdio.onerror = (e) => log('engine error:', e.message);

  await stdio.start();
  stdio.stderr?.on('data', (d) => log('[engine]', String(d).trimEnd()));
  await httpTransport.start();

  return httpTransport;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const isInitialize = (body) =>
  Array.isArray(body) ? body.some((m) => m?.method === 'initialize') : body?.method === 'initialize';

function secretMatches(provided) {
  const expected = Buffer.from(SHARED_SECRET);
  const actual = Buffer.from(String(provided ?? ''));
  // Length must match before timingSafeEqual, which throws on differing lengths.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const rpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Resolves the acting user, or null if the request must be rejected.
 * Production fails closed: a missing or malformed id is an error, never a fallback to a
 * shared directory. A silent fallback would collapse every user into one identity — the
 * exact failure this design exists to prevent — with nothing in the logs to notice.
 */
function resolveUserId(req, res) {
  const header = req.headers['x-librechat-user-id'];
  const value = Array.isArray(header) ? header[0] : header;

  if (isValidUserId(value)) return value;

  if (!PRODUCTION) return SHARED_DEV_USER;

  log(`[auth] rejected request with invalid user id: ${JSON.stringify(value)}`);
  sendJson(res, 400, rpcError(-32602, 'Missing or malformed X-LibreChat-User-Id header'));
  return null;
}

/**
 * Dependency probes run ONCE at boot and are cached. `az version` cold-starts a Python
 * runtime and can take seconds, so probing per request would make /health slow enough to
 * fail a platform health check on a container that is actually fine. These are image
 * properties, not runtime state — they cannot change without a redeploy.
 */
const dependencies = { azCli: false, engineBundle: false };

async function probeDependencies() {
  const [azOk, engineOk] = await Promise.all([
    new Promise((resolve) => {
      const probe = spawn('az', ['version'], { stdio: 'ignore' });
      probe.on('error', () => resolve(false));
      probe.on('exit', (code) => resolve(code === 0));
    }),
    access(new URL('./vendor/mcp.mjs', import.meta.url)).then(() => true, () => false),
  ]);
  dependencies.azCli = azOk;
  dependencies.engineBundle = engineOk;
  if (!azOk) log('WARNING: `az` is not runnable — every tool call will fail. Broken image?');
  if (!engineOk) log('WARNING: vendor/mcp.mjs is missing — every session will fail. Broken image?');
}

function healthPayload() {
  return {
    status: dependencies.azCli && dependencies.engineBundle ? 'ok' : 'degraded',
    mode: PRODUCTION ? 'production' : 'dev',
    azCli: dependencies.azCli,
    engineBundle: dependencies.engineBundle,
    sessions: sessions.size,
    pendingLogins: logins.size,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const payload = healthPayload();
    return sendJson(res, payload.status === 'ok' ? 200 : 503, payload);
  }

  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end('not found');
    return;
  }

  if (PRODUCTION && !secretMatches(req.headers['x-bridge-secret'])) {
    log('[auth] rejected request with bad or missing bridge secret');
    return sendJson(res, 401, rpcError(-32001, 'Unauthorized'));
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const sessionId = req.headers['mcp-session-id'];
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      existing.lastActivity = Date.now();
      return await existing.http.handleRequest(req, res, body);
    }

    if (isInitialize(body)) {
      const userId = resolveUserId(req, res);
      if (!userId) return;
      const transport = await createSession(userId);
      return await transport.handleRequest(req, res, body);
    }

    // Unknown or expired session id, or a GET/DELETE before initialize. 404 is what the
    // spec prescribes, and what makes LibreChat re-initialize instead of hanging — which
    // is also how a reaped session silently recovers.
    sendJson(res, 404, rpcError(-32001, 'Session not found'));
  } catch (e) {
    log('request failed:', e.stack || e.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(-32603, e.message)));
  }
});

const reaper = setInterval(() => {
  reapIdleSessions();
  reapStaleLogins();
}, REAPER_INTERVAL_MS);
reaper.unref();

// Probe before listening so the first health check already reflects reality, rather than
// reporting a false 'degraded' and failing a deploy that would otherwise be fine.
await probeDependencies();

server.listen(PORT, HOST, () => {
  log(`FlowAgent MCP bridge listening on http://${HOST}:${PORT}/mcp (port from ${PORT_SOURCE})`);
  if (PORT_SOURCE === 'PORT' && process.env.FLOWAGENT_BRIDGE_PORT && Number(process.env.FLOWAGENT_BRIDGE_PORT) !== PORT) {
    log(
      `WARNING: FLOWAGENT_BRIDGE_PORT=${process.env.FLOWAGENT_BRIDGE_PORT} is being IGNORED because PORT=${process.env.PORT} takes precedence. ` +
        'Whatever calls this bridge must use ' +
        PORT +
        ' — set PORT instead.',
    );
  }
  log(
    PRODUCTION
      ? `mode=production (auth enforced, fail-closed, per-user Azure identity) usersRoot=${USERS_ROOT}`
      : "mode=dev (no auth; ALL users share this host's az login — never deploy this way)",
  );
  log(`dependencies: az=${dependencies.azCli} engineBundle=${dependencies.engineBundle}`);
  if (!TENANT_ID) log('WARNING: no AZURE_TENANT_ID/PA_TENANT_ID set — az login will not be tenant-scoped');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — shutting down ${sessions.size} session(s)`);
    for (const id of [...sessions.keys()]) closeSession(id);
    server.close(() => process.exit(0));
  });
}
