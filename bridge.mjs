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
// employee's automation. Each user therefore gets their own engine process acting with
// their own Power Automate permissions.
//
// HOW IDENTITY WORKS (production): LibreChat signs users in with Entra and, via its `obo`
// MCP option, sends each request with an Entra token for this bridge's app registration.
// The bridge validates it, then trades it (On-Behalf-Of) for the Power Automate, Dataverse
// and Graph tokens the engine asks for. The engine still believes it is calling `az`: in
// production its PATH starts with ./bin, whose `az` fetches those tokens from the bridge.
// No Azure CLI login, no device code, and no refresh tokens stored by the bridge.
//
// This is a transport-level proxy: JSON-RPC frames pass through verbatim except for
// auth-error rewriting in `forwardToClient`, so new engine tools appear without touching
// this file.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, access, rm, chmod } from 'node:fs/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';
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
// In production the bridge requires an Entra user token on every request; in dev it uses the
// host's own `az` login so the zero-config local flow keeps working.
const PRODUCTION = SHARED_SECRET.length > 0;

/** The bridge's own app registration: audience of incoming tokens and the OBO client. */
const BRIDGE_CLIENT_ID = process.env.BRIDGE_CLIENT_ID || '';
/** Client ID of a user-assigned managed identity. Unset means the system-assigned one. */
const MANAGED_IDENTITY_CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
/** Delegated scope the bridge's app registration exposes; LibreChat's `obo.scopes` asks for it. */
const REQUIRED_SCOPE = 'access_as_user';
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;
const SHIM_DIR = new URL('./bin', import.meta.url).pathname;
const TOKEN_SOCKET = path.join(os.tmpdir(), `flowagent-bridge-${process.pid}.sock`);
/** Matches the engine's own refresh buffer, so neither side hands out a token the other rejects. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

if (PRODUCTION) {
  // Fail at boot, not on the first tool call: without these every request would be rejected
  // or every token exchange would fail, and the cause would only show up in per-call errors.
  // IDENTITY_ENDPOINT/IDENTITY_HEADER are injected by Container Apps once an identity is assigned.
  const missing = [
    !TENANT_ID && 'AZURE_TENANT_ID',
    !BRIDGE_CLIENT_ID && 'BRIDGE_CLIENT_ID',
    !process.env.IDENTITY_ENDPOINT && 'IDENTITY_ENDPOINT (assign a managed identity)',
    !process.env.IDENTITY_HEADER && 'IDENTITY_HEADER (assign a managed identity)',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`FATAL: production mode (BRIDGE_SHARED_SECRET set) also requires: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS || 30 * 60 * 1000);
const REAPER_INTERVAL_MS = 60 * 1000;

/** Dev-only stand-in identity used when no user header is present. See `engineEnv`. */
const SHARED_DEV_USER = '_shared';

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Structured per-tool-call audit line. Who did what, under which Azure identity. */
const audit = (entry) => console.log(JSON.stringify({ type: 'audit', ...entry }));

/** sessionId -> { http, stdio, auth, lastActivity } */
const sessions = new Map();
/** Token-broker key -> auth of the session whose engine holds that key. Production only. */
const brokerKeys = new Map();

/**
 * LibreChat user ids are Mongo ObjectIds. Dev mode only — used for logs, never for isolation.
 */
const isValidUserId = (value) => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);

/**
 * Entra object ids (the `oid` claim) key the per-user directories in production. The value
 * becomes a filesystem path component under a shared volume, so it is allowlisted.
 */
const isEntraObjectId = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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
 * BRIDGE_SHARED_SECRET and the managed-identity endpoint into a subprocess that has no use
 * for them, and would let the bridge's own HOME leak in and defeat per-user isolation.
 *
 * Dev mode is the deliberate exception: every session points at the developer's real
 * `~/.azure`, so a local `az login` keeps working exactly as it did before per-user
 * isolation existed. Production never takes this branch.
 *
 * In production PATH starts with ./bin so the engine's `az` calls reach the token broker,
 * and the engine's on-disk token cache is off: tokens stay in memory instead of being
 * written as plaintext JSON under the user's directory.
 */
function engineEnv(auth) {
  const isHostDeveloper = !PRODUCTION;
  const dir = isHostDeveloper ? path.join(process.env.HOME ?? '', '.azure') : userDir(auth.userId);
  const home = isHostDeveloper ? (process.env.HOME ?? '') : userDir(auth.userId);
  return {
    PATH: isHostDeveloper ? process.env.PATH : `${SHIM_DIR}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    AZURE_CONFIG_DIR: dir,
    FLOWAGENT_MSAL_CACHE_DIR: dir,
    FLOWAGENT_TOKEN_CACHE_DIR: dir,
    ...(isHostDeveloper
      ? {}
      : {
          FLOWAGENT_DISABLE_DISK_CACHE: '1',
          FLOWAGENT_BRIDGE_TOKEN_SOCKET: TOKEN_SOCKET,
          FLOWAGENT_BRIDGE_TOKEN_KEY: auth.key,
        }),
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
  brokerKeys.delete(entry.auth.key);
  entry.stdio.close().catch(() => {});
  entry.http.close().catch(() => {});
  log(`session ${id} closed (${sessions.size} active)`);
}

// ---------------------------------------------------------------------------
// Message interception
// ---------------------------------------------------------------------------

/**
 * The engine reports auth failures as human text telling the user to run `az login`,
 * which is meaningless in a chat UI with no shell. Matching is on message substrings
 * rather than a structured code because the engine does not serialize its
 * AzCliAuthError `.code` onto the wire — only the message text reaches us.
 *
 * In production those failures come from the On-Behalf-Of exchange, whose AADSTS code the
 * engine carries through as "Technical detail". Order matters: the engine words every
 * unrecognised AADSTS error as a license problem, so the specific codes must match first.
 */
const AUTH_REWRITES = [
  {
    // Missing admin consent on the bridge's app registration. No user can fix this.
    match: /AADSTS65001|AADSTS650057|AADSTS90094/i,
    text: 'The Power Automate integration is missing a permission that only an administrator can grant. Please report this to IT, including the technical detail below.',
    serverBug: true,
  },
  {
    match: /AADSTS530\d\d/i,
    text: "This request was blocked by your organization's Conditional Access policy. Please contact IT, including the technical detail below.",
  },
  {
    match: /signed in to azure|run this command to sign in|please run ['"]?az login|session has expired/i,
    text: PRODUCTION
      ? 'Microsoft needs you to sign in again before Power Automate can be used. Sign out of the chat, sign back in, and retry.'
      : 'The bridge host is not signed in to Azure. Run `az login` on the machine running the bridge.',
  },
  {
    // Distinct on purpose: these users ARE signed in, they lack a license or rights.
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

// ---------------------------------------------------------------------------
// Entra identity and On-Behalf-Of token broker (production)
// ---------------------------------------------------------------------------

const jwks = PRODUCTION ? createRemoteJWKSet(new URL(`${AUTHORITY}/discovery/v2.0/keys`)) : null;

/**
 * Validates the Entra token LibreChat sends (obtained by its own OBO exchange for this
 * bridge's `access_as_user` scope). Returns the caller's identity, or null to reject.
 */
async function authenticate(req) {
  const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
  if (!match) return null;
  try {
    const { payload } = await jwtVerify(match[1], jwks, {
      // Entra issues v2 or v1 tokens depending on the app registration's
      // accessTokenAcceptedVersion; accept both rather than fail on a portal setting.
      issuer: [`${AUTHORITY}/v2.0`, `https://sts.windows.net/${TENANT_ID}/`],
      audience: [BRIDGE_CLIENT_ID, `api://${BRIDGE_CLIENT_ID}`],
      algorithms: ['RS256'],
    });
    // App-only tokens carry `roles`, not `scp`. Only a delegated token names a user whose
    // permissions the engine can act with — the isolation this bridge exists for.
    const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ') : [];
    if (!scopes.includes(REQUIRED_SCOPE) || !isEntraObjectId(payload.oid)) {
      log(`[auth] rejected token without ${REQUIRED_SCOPE} or oid: scp=${JSON.stringify(payload.scp)}`);
      return null;
    }
    return { userId: payload.oid, user: payload.preferred_username ?? payload.upn ?? '', token: match[1] };
  } catch (e) {
    log(`[auth] rejected token: ${e.code ?? e.message}`);
    return null;
  }
}

let miAssertion = null;

/**
 * The bridge's credential for the OBO exchange: a managed-identity token, which the bridge's
 * app registration trusts through a federated identity credential. No client secret exists.
 * Container Apps serves these at IDENTITY_ENDPOINT, guarded by IDENTITY_HEADER.
 */
async function managedIdentityAssertion() {
  if (miAssertion && Date.now() < miAssertion.expiresAt - TOKEN_REFRESH_MARGIN_MS) return miAssertion.token;
  const url = new URL(process.env.IDENTITY_ENDPOINT);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', 'api://AzureADTokenExchange');
  if (MANAGED_IDENTITY_CLIENT_ID) url.searchParams.set('client_id', MANAGED_IDENTITY_CLIENT_ID);
  const res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': process.env.IDENTITY_HEADER } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Managed identity token request failed (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  miAssertion = { token: body.access_token, expiresAt: Number(body.expires_on) * 1000 };
  return miAssertion.token;
}

async function exchangeOnBehalfOf(assertion, scope) {
  const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      requested_token_use: 'on_behalf_of',
      client_id: BRIDGE_CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await managedIdentityAssertion(),
      assertion,
      scope,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // error_description opens with the AADSTS code that the engine and AUTH_REWRITES key on.
    throw new Error(String(body.error_description ?? body.error ?? `HTTP ${res.status}`).split(/\r?\n/)[0]);
  }
  return { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 };
}

/** `${userId}\0${scope}` -> { token, expiresAt } */
const downstreamTokens = new Map();
/** Same key -> in-flight exchange, so parallel engine calls share one request to Entra. */
const pendingExchanges = new Map();

async function downstreamToken(auth, resource) {
  // `az` takes a v1 resource, OBO takes a v2 scope; Dataverse URLs arrive with a trailing slash.
  const scope = `${resource.replace(/\/+$/, '')}/.default`;
  const key = `${auth.userId}\0${scope}`;
  const cached = downstreamTokens.get(key);
  if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return cached;

  if (!pendingExchanges.has(key)) {
    const exchange = exchangeOnBehalfOf(auth.assertion, scope)
      .then((token) => {
        downstreamTokens.set(key, token);
        log(`[obo] user=${auth.userId} scope=${scope} ok`);
        return token;
      })
      .finally(() => pendingExchanges.delete(key));
    pendingExchanges.set(key, exchange);
  }
  return pendingExchanges.get(key);
}

/**
 * Serves tokens to the engine's `az` stand-in (bin/az) over a Unix socket, so nothing outside
 * this container can reach it. The per-session key ties each engine to its own user's token.
 */
const tokenBroker = http.createServer(async (req, res) => {
  const auth = brokerKeys.get(req.headers['x-flowagent-key']);
  const resource = new URL(req.url ?? '', 'http://broker').searchParams.get('resource');
  if (!auth || !resource) return sendJson(res, 403, { error: 'flowagent-bridge: unknown session' });
  try {
    const token = await downstreamToken(auth, resource);
    sendJson(res, 200, { accessToken: token.token, expiresOn: new Date(token.expiresAt).toISOString() });
  } catch (e) {
    log(`[obo] user=${auth.userId} resource=${resource} failed: ${e.message}`);
    sendJson(res, 502, { error: e.message });
  }
});

function pruneExpiredTokens() {
  const now = Date.now();
  for (const [key, token] of downstreamTokens) {
    if (now >= token.expiresAt) downstreamTokens.delete(key);
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
async function createSession(auth) {
  await ensureUserDir(auth.userId);
  if (PRODUCTION) brokerKeys.set(auth.key, auth);

  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [LAUNCHER],
    env: engineEnv(auth),
    stderr: 'pipe',
  });

  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { http: httpTransport, stdio, auth, lastActivity: Date.now() });
      log(`session ${id} initialized for user=${auth.userId} ${auth.user} (${sessions.size} active)`);
    },
  });

  const pending = new Map();

  const forwardToEngine = async (msg) => {
    if (msg?.method === 'tools/call' && msg?.id != null) {
      pending.set(msg.id, { tool: msg.params?.name, started: Date.now() });
    }
    await stdio.send(msg);
  };

  const forwardToClient = async (msg) => {
    if (msg?.id != null && pending.has(msg.id)) {
      const { tool, started } = pending.get(msg.id);
      pending.delete(msg.id);
      audit({ userId: auth.userId, user: auth.user, tool, durationMs: Date.now() - started, ok: !msg?.result?.isError });
    }
    await httpTransport.send(interceptEngineResult(msg));
  };

  httpTransport.onmessage = (msg) => forwardToEngine(msg).catch((e) => log('-> engine failed:', e.message));
  stdio.onmessage = (msg) => forwardToClient(msg).catch((e) => log('<- client failed:', e.message));

  httpTransport.onclose = () => httpTransport.sessionId && closeSession(httpTransport.sessionId);
  stdio.onclose = () => {
    // Also covers an engine that died before its session ever initialized.
    brokerKeys.delete(auth.key);
    if (httpTransport.sessionId) closeSession(httpTransport.sessionId);
  };
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

/** Dev mode only: the LibreChat user id header labels logs; it never selects an identity. */
function devUserId(req) {
  const header = req.headers['x-librechat-user-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return isValidUserId(value) ? value : SHARED_DEV_USER;
}

/**
 * Dependency probes run ONCE at boot and are cached. `az version` cold-starts a Python
 * runtime and can take seconds, so probing per request would make /health slow enough to
 * fail a platform health check on a container that is actually fine. These are image
 * properties, not runtime state — they cannot change without a redeploy.
 */
const dependencies = {};

async function probeDependencies() {
  const runnable = (target, mode) => access(target, mode).then(() => true, () => false);
  const checks = {
    // Production runs the engine against bin/az; dev against the host's real Azure CLI.
    ...(PRODUCTION
      ? { tokenShim: runnable(path.join(SHIM_DIR, 'az'), fsConstants.X_OK) }
      : {
          azCli: new Promise((resolve) => {
            const probe = spawn('az', ['version'], { stdio: 'ignore' });
            probe.on('error', () => resolve(false));
            probe.on('exit', (code) => resolve(code === 0));
          }),
        }),
    engineBundle: runnable(new URL('./vendor/mcp.mjs', import.meta.url)),
  };
  for (const [name, check] of Object.entries(checks)) dependencies[name] = await check;
  for (const [name, ok] of Object.entries(dependencies)) {
    if (!ok) log(`WARNING: dependency "${name}" is missing — every tool call will fail. Broken image?`);
  }
}

function healthPayload() {
  return {
    status: Object.values(dependencies).every(Boolean) ? 'ok' : 'degraded',
    mode: PRODUCTION ? 'production' : 'dev',
    ...dependencies,
    sessions: sessions.size,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const payload = healthPayload();
    return sendJson(res, payload.status === 'ok' ? 200 : 503, payload);
  }

  if (!req.url?.startsWith('/mcp')) {
    // JSON, not plain text: MCP clients probe unknown paths (OAuth discovery among them)
    // and parse the body as JSON, so `not found` produces a misleading parse error in
    // their logs instead of a clean 404.
    return sendJson(res, 404, rpcError(-32601, 'Not found'));
  }

  if (PRODUCTION && !secretMatches(req.headers['x-bridge-secret'])) {
    // Deliberately 404, NOT 401/403. LibreChat's OAuth detection sends a bare HEAD probe
    // with none of the configured headers; any 401/403 it sees is taken as an OAuth
    // challenge (MCP_OAUTH_ON_AUTH_ERROR), after which it refuses to use the working
    // authenticated connection and fails hunting for OAuth endpoints that do not exist.
    // A 404 also avoids advertising that a protected endpoint lives here at all, which
    // suits an unlisted service on a private network.
    log(`[auth] rejected ${req.method} ${req.url} — bad or missing bridge secret`);
    return sendJson(res, 404, rpcError(-32601, 'Not found'));
  }

  let identity = null;
  if (PRODUCTION) {
    identity = await authenticate(req);
    if (!identity) {
      // 401 is safe past the secret check: the caller has proved it is LibreChat, and
      // LibreChat treats a 401 from an `obo` server as a plain auth failure, not as an
      // OAuth challenge (MCPConnectionFactory.createConnection).
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' });
      return res.end(JSON.stringify(rpcError(-32001, 'Missing or invalid Entra bearer token')));
    }
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const sessionId = req.headers['mcp-session-id'];
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      if (PRODUCTION) {
        // A session belongs to the user who opened it. Letting another user's token drive it
        // would run tools as the first user, so it is answered as if it did not exist.
        if (existing.auth.userId !== identity.userId) {
          log(`[auth] user=${identity.userId} tried session ${sessionId} owned by user=${existing.auth.userId}`);
          return sendJson(res, 404, rpcError(-32001, 'Session not found'));
        }
        // LibreChat re-runs its OBO exchange per call; keep the freshest token for the broker.
        existing.auth.assertion = identity.token;
      }
      existing.lastActivity = Date.now();
      return await existing.http.handleRequest(req, res, body);
    }

    if (isInitialize(body)) {
      const auth = PRODUCTION
        ? { userId: identity.userId, user: identity.user, assertion: identity.token, key: randomBytes(32).toString('hex') }
        : { userId: devUserId(req), user: '', assertion: null, key: null };
      const transport = await createSession(auth);
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
  pruneExpiredTokens();
}, REAPER_INTERVAL_MS);
reaper.unref();

// Probe before listening so the first health check already reflects reality, rather than
// reporting a false 'degraded' and failing a deploy that would otherwise be fine.
await probeDependencies();

if (PRODUCTION) {
  // A stale socket from a previous run in the same container would make listen() fail.
  await rm(TOKEN_SOCKET, { force: true });
  await new Promise((resolve, reject) => tokenBroker.listen(TOKEN_SOCKET, resolve).on('error', reject));
  await chmod(TOKEN_SOCKET, 0o600);
  // Not a health check: the identity endpoint is runtime state, and a transient failure here
  // must not wedge /health. Logged so a misconfigured identity shows up in the boot log.
  managedIdentityAssertion().then(
    () => log('managed identity: token obtained'),
    (e) => log(`WARNING: managed identity unavailable — every tool call will fail: ${e.message}`),
  );
}

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
      ? `mode=production (bridge secret + Entra token required, per-user identity via On-Behalf-Of) usersRoot=${USERS_ROOT}`
      : "mode=dev (no auth; ALL users share this host's az login — never deploy this way)",
  );
  log(`dependencies: ${JSON.stringify(dependencies)}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — shutting down ${sessions.size} session(s)`);
    for (const id of [...sessions.keys()]) closeSession(id);
    server.close(() => process.exit(0));
  });
}
