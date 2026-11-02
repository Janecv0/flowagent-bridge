# FlowAgent MCP bridge

Exposes Microsoft's Power Automate **FlowAgent** MCP server to LibreChat, giving each
LibreChat user their **own Azure identity** rather than a shared one, with no extra sign-in
step: a user signed in to LibreChat with their Microsoft work account is already connected.

## Why this exists

The FlowAgent engine (`vendor/mcp.mjs`) speaks stdio only and authenticates by shelling
out to the Azure CLI. It has no code path that accepts a bearer token supplied per
request, so LibreChat can neither run it as a `type: stdio` server (its container has no
`az`) nor drive it as an OAuth resource server. This process fronts it over HTTP instead.

**Why per-user matters:** Power Automate connections execute as their *owner* regardless
of who triggers them, and environment-admin visibility exposes any flow's run history —
the actual emails and files that passed through it. Under a single shared identity, any
LibreChat user could trigger, read, and edit every other employee's automation. Each user
therefore gets their own engine process acting with that person's own Power Automate
permissions. No elevated role is needed for the integration itself.

## How identity works

```
LibreChat ──Entra token for this bridge (LibreChat's own OBO, every call)──> bridge.mjs
bridge.mjs ──validates it, then OBO per resource──> Power Automate / Dataverse / Graph tokens
engine ──runs `az account get-access-token`──> bin/az ──Unix socket──> bridge.mjs
```

1. The user signs in to LibreChat with Entra (OpenID). With `OPENID_REUSE_TOKENS=true`,
   LibreChat keeps that token, and the MCP server's `obo:` option makes LibreChat exchange
   it on every tool call for a token for this bridge's `access_as_user` scope.
2. The bridge validates that token (signature, tenant, audience, delegated `scp`) and keys
   everything on the user's Entra object id (`oid`).
3. The engine asks for tokens the only way it knows: `az account get-access-token`. In
   production its `PATH` starts with `bin/`, so that call reaches `bin/az`, which asks the
   bridge over a Unix socket. The bridge performs the On-Behalf-Of (OBO) exchange for that
   resource and caches the result per user until shortly before it expires.
4. The bridge proves its own identity to Entra with a **managed identity** that its app
   registration trusts as a federated credential. There is no client secret anywhere.

No device code, no Azure CLI login, no refresh tokens held by the bridge.

## Files

| File | Purpose |
|---|---|
| `bridge.mjs` | HTTP server, token validation, OBO token broker, per-user sessions |
| `bin/az` | Stand-in for the Azure CLI inside engine children (production only) |
| `launch.mjs` | Works around an upstream crash in the engine bundle, then imports it |
| `vendor/mcp.mjs` | Vendored copy of Microsoft's engine bundle |
| `Dockerfile` | `node:24.16.0-slim`; no Azure CLI (~370 MB) |

### Why `launch.mjs` exists

`node vendor/mcp.mjs` crashes immediately with
`Dynamic require of "buffer" is not supported`. The bundle's esbuild `__require` shim has
no fallback for Node builtins, which its inlined CommonJS deps (safe-buffer → jws →
jsonwebtoken) require at load time. `launch.mjs` defines `globalThis.require` before
importing, which satisfies the shim without patching the vendored file.

**This is an upstream bug**, reproducible from a clean checkout — Microsoft's own `/setup`
skill would hit it too. Re-verify the shim after re-vendoring a newer bundle.

### Re-vendoring

```bash
cp ../power-platform-skills/plugins/power-automate/server/mcp.mjs vendor/mcp.mjs
node launch.mjs   # must print "FlowAgent MCP server running on stdio (N tools)"
grep -n 'spawnSync[0-9]*("az"' vendor/mcp.mjs   # bin/az answers these; check none is new
```

`vendor/mcp.mjs` is an unmodified copy from
[microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
(`plugins/power-automate/server/mcp.mjs`), redistributed under the MIT License —
see `vendor/LICENSE`. Copyright (c) Microsoft Corporation.

## Two modes

The presence of `BRIDGE_SHARED_SECRET` decides everything:

| | dev (no secret) | production (secret set) |
|---|---|---|
| Request auth | none | `X-Bridge-Secret` (else 404) **and** an Entra bearer token (else 401) |
| Identity | the host's own `~/.azure` for everyone | the token's `oid`, one engine per session |
| Engine tokens | the host's real `az` | OBO via `bin/az` |
| Startup | always | exits if tenant, client id or managed identity is missing |

Dev mode deliberately ignores per-user isolation: it is a single developer machine running
against the developer's own `az login`.

A session is bound to the user who opened it: a request carrying another user's token for
an existing session id gets 404, so one user can never drive another user's engine.

## Running locally

```bash
FLOWAGENT_BRIDGE_HOST=172.17.0.1 node bridge.mjs
```

Bind to the docker0 address locally: dev mode is unauthenticated, so it must not be
reachable from the LAN. Check with `curl http://172.17.0.1:8791/health`. Dev mode uses your
own `az login`; a local LibreChat with email login must point at it **without** `obo:`.

## Deploying to Azure Container Apps

### Entra (needs an Application Administrator)

1. **User-assigned managed identity** for the bridge. Note its client id and principal id.
2. **App registration** for the bridge, single tenant:
   - *Expose an API*: Application ID URI `api://<bridge-client-id>`, scope `access_as_user`
     (the name is fixed in `bridge.mjs`).
   - *Manifest*: `requestedAccessTokenVersion: 2` (v1 tokens are accepted too).
   - *Certificates & secrets → Federated credentials → Managed identity*: select the
     identity from step 1, audience `api://AzureADTokenExchange`.
   - *API permissions*, delegated, then **Grant admin consent**:
     - Power Automate service (Microsoft Flow Service): `Flows.Read.All`, `Flows.Manage.All`
     - Dynamics CRM: `user_impersonation` (desktop flows, connection references)
     - Microsoft Graph: `User.ReadBasic.All` (user search)
3. **LibreChat's own app registration** (the one users sign in to LibreChat with): add the
   delegated permission `api://<bridge-client-id>/access_as_user` and grant admin consent.

### LibreChat (config only, no code changes; v0.8.7+)

- Env: `OPENID_REUSE_TOKENS=true`, and `OPENID_SCOPE` must include a scope on LibreChat's
  **own** app (`api://<librechat-client-id>/...`). Otherwise its access token is a Graph
  token, which Entra refuses to exchange. If Entra people search works, the first is set;
  the second must be checked. Set `OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED=true` when
  adding the scope, so LibreChat still reads the user profile.
- `librechat.yaml`:

  ```yaml
  mcpServers:
    power-automate:
      type: streamable-http
      url: https://<bridge-host>/mcp
      requiresOAuth: false      # keep: stops LibreChat's OAuth auto-detection
      timeout: 120000
      obo:
        scopes: "api://<bridge-client-id>/access_as_user"
      headers:
        X-Bridge-Secret: "${BRIDGE_SHARED_SECRET}"
  ```

  If the bridge has internal ingress (private IP), LibreChat's SSRF guard blocks it unless
  its `host:port` is in `mcpSettings.allowedAddresses`; if `mcpSettings.allowedDomains` is
  non-empty, the host must be listed there too.

### Container App

- Image from this Dockerfile; target port `8791`; health probe `GET /health`.
- Assign the managed identity from step 1. Container Apps then injects
  `IDENTITY_ENDPOINT` and `IDENTITY_HEADER`.
- **Exactly one replica** (min = max = 1): sessions live in memory.
- No volume needed: no tokens are written to disk.
- Set `FLOWAGENT_BRIDGE_HOST=0.0.0.0` if the container has no IPv6.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_SHARED_SECRET` | — | Enables production mode; LibreChat sends it as `X-Bridge-Secret` |
| `AZURE_TENANT_ID` / `PA_TENANT_ID` | — | Tenant; required in production |
| `BRIDGE_CLIENT_ID` | — | The bridge's app registration; required in production |
| `AZURE_CLIENT_ID` | — | Client id of the user-assigned managed identity (unset = system-assigned) |
| `IDENTITY_ENDPOINT` / `IDENTITY_HEADER` | injected | Managed identity endpoint (Container Apps sets these) |
| `PORT` | — | Listen port. Takes precedence — most platforms assign the port they route and health-check on here |
| `FLOWAGENT_BRIDGE_PORT` | `8791` | Listen port fallback, for local runs where `PORT` is already taken |
| `FLOWAGENT_BRIDGE_HOST` | `::` | Bind address |
| `USERS_ROOT` | `/data/pa-users` | Per-user engine home directories (production only) |
| `PA_DEFAULT_ENVIRONMENT` | — | Passed to the engine |
| `SESSION_IDLE_MS` | `1800000` | Idle timeout before an engine child is reaped |

### First test after deploying

Run, as a normal user, in this order: `list_environments`, `list_flows`, `get_flow`,
`get_run_history`, `run_flow` on a manual flow, then the Dataverse-backed
`list_desktop_flows`. Each first
call per resource logs `[obo] user=… scope=… ok` or the AADSTS error. What these prove:

- **Power Automate API accepts our app's token.** Microsoft documents that customer apps get
  delegated Flow tokens, but the engine also calls per-environment `api.powerplatform.com`
  endpoints with them, which only a live test confirms.
- **`invoke_operation`** needs a token for `apihub.azure.com`, whose delegated permissions
  for customer apps are undocumented; expect it to fail until proven otherwise.
- **Managed Environments** with app access control on must allow-list the bridge's app id
  for Dataverse calls.
- **Conditional Access**: device-code blocks do not apply. Device and MFA state should carry
  over from the user's LibreChat sign-in (reported, not documented); check the sign-in logs
  for any location policy evaluated against the bridge's outbound IP.
- **Connection-management tools** (create/consent connections) use a separate interactive
  MSAL login inside the engine and do not work in a container — unchanged from before.

## Error messages users see

Engine errors telling users to "run `az login`" make no sense in a chat, so the bridge
rewrites them (`AUTH_REWRITES`), keeping the original as technical detail:

| Cause | Message |
|---|---|
| AADSTS65001 / 650057 / 90094 — missing admin consent | report to IT (also logged as `[server-bug]`) |
| AADSTS530xx — Conditional Access | contact IT |
| sign-in required / expired | sign out of the chat and back in |
| no license / no environment access | contact IT about the license |

## Operational notes

- **Single replica only.** Sessions are an in-memory map. Do not scale beyond 1.
- **Memory** is ~75 MB per live engine child. Idle reaping (30 min default) bounds it;
  LibreChat transparently reconnects afterward, so reaping is invisible to users.
- **One engine child per session, not per user** — deliberate. The engine holds mutable
  `set_current_env`/`set_current_flow` state, so pooling would let one chat silently
  reassign another chat's working environment.
- Every tool call emits an audit line: `{"type":"audit","userId","user","tool","durationMs","ok"}`
  where `userId` is the Entra object id and `user` the sign-in name.

## Security

- The bridge accepts only Entra tokens issued for its own app registration, from its own
  tenant, carrying the delegated `access_as_user` scope; app-only tokens are rejected. The
  shared secret is defense in depth on top.
- Downstream tokens exist only in the bridge's memory and in each engine process; the
  engine's disk token cache is turned off. The token broker listens on a Unix socket
  (mode 0600) and serves each engine only its own user's tokens, keyed by a per-session
  random key.
- **Offboarding is Entra's job:** a disabled user can no longer get or exchange tokens;
  tokens already issued, including the bridge's cached ones, lapse within about an hour.
  Nothing to delete on the bridge.
