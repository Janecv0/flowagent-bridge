# FlowAgent MCP bridge

Exposes Microsoft's Power Automate **FlowAgent** MCP server to LibreChat, giving each
LibreChat user their **own Azure identity** rather than a shared one.

## Why this exists

The FlowAgent engine (`vendor/mcp.mjs`) speaks stdio only and authenticates by shelling
out to the Azure CLI. It has no code path that accepts a bearer token supplied per
request, so LibreChat can neither run it as a `type: stdio` server (its container has no
`az`) nor drive it as an OAuth resource server. This process fronts it over HTTP instead.

**Why per-user matters:** Power Automate connections execute as their *owner* regardless
of who triggers them, and environment-admin visibility exposes any flow's run history —
the actual emails and files that passed through it. Under a single shared identity, any
LibreChat user could trigger, read, and edit every other employee's automation. Each user
therefore gets their own engine process with its own `AZURE_CONFIG_DIR`, so `az` operates
against that person's own login and their own real Power Automate permissions. No
elevated role is needed for the integration itself.

```
LibreChat  --http-->  bridge.mjs  --stdio-->  launch.mjs -> vendor/mcp.mjs -> az
             X-LibreChat-User-Id      one engine child per session,
             X-Bridge-Secret          AZURE_CONFIG_DIR=<USERS_ROOT>/<userId>
```

## Files

| File | Purpose |
|---|---|
| `bridge.mjs` | HTTP server, per-user isolation, session/login lifecycle, tool interception |
| `launch.mjs` | Works around an upstream crash in the engine bundle, then imports it |
| `vendor/mcp.mjs` | Vendored copy of Microsoft's engine bundle |
| `Dockerfile` | `node:24.16.0-slim` + Azure CLI |

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
```

`vendor/mcp.mjs` is an unmodified copy from
[microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
(`plugins/power-automate/server/mcp.mjs`), redistributed under the MIT License —
see `vendor/LICENSE`. Copyright (c) Microsoft Corporation.

## Two modes

The presence of `BRIDGE_SHARED_SECRET` decides everything:

| | dev (no secret) | production (secret set) |
|---|---|---|
| Request auth | none | `X-Bridge-Secret` required, else 401 |
| Missing/invalid user id | falls back | **400 — fails closed** |
| Azure identity | the host's own `~/.azure` for everyone | isolated per user under `USERS_ROOT` |

Dev mode deliberately ignores per-user isolation: it is a single developer machine, and
isolating there would force a device-code login against an empty directory for no benefit.

The fail-closed rule in production is load-bearing. A silent fallback to a shared
directory would collapse every employee onto one Azure identity — precisely the failure
this design exists to prevent — with nothing in the logs to notice.

## Running locally

```bash
FLOWAGENT_BRIDGE_HOST=172.17.0.1 node bridge.mjs
```

Bind to the docker0 address locally: dev mode is unauthenticated, so it must not be
reachable from the LAN. Check with `curl http://172.17.0.1:8791/health`.

LibreChat reaches it at `http://flowagent-bridge.railway.internal:8791/mcp` in both
environments — `docker-compose.override.yml` maps that hostname to the Docker host via
`extra_hosts`. That indirection exists because **`${VAR}` is not substituted in
`mcpServers.*.url`**: `MCPServerInspector` reads `config.url` raw at startup, so a
templated URL fails with `Domain "unknown" is not allowed` and never registers. Headers
*are* templated per call, so the secret and user id can stay as `${VAR}`/`{{VAR}}`.

If LibreChat starts before the bridge, it stores a stub and the tools stay missing until
`docker compose restart api`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FLOWAGENT_BRIDGE_PORT` | `8791` | Listen port |
| `FLOWAGENT_BRIDGE_HOST` | `::` | Bind address. `::` is required on Railway (IPv6-only private network) |
| `USERS_ROOT` | `/data/pa-users` | Per-user Azure config dirs (production only) |
| `BRIDGE_SHARED_SECRET` | — | Enables production mode |
| `AZURE_TENANT_ID` / `PA_TENANT_ID` | — | Tenant for `az login --tenant` |
| `PA_CLIENT_ID` | — | Only needed for connection-management tools |
| `SESSION_IDLE_MS` | `1800000` | Idle timeout before an engine child is reaped |

## Conditional Access is the thing most likely to stop you

Set `AZURE_TENANT_ID` to the tenant whose Power Automate environments you want to reach.

Before building anything around this, **test device-code sign-in against that tenant**,
because Conditional Access can make this approach unusable and there is no client-side
workaround:

```bash
AZURE_CONFIG_DIR=$(mktemp -d) az login --use-device-code --tenant <tenant-id>
```

If that returns `AADSTS53003 BlockedByConditionalAccess`, the tenant enforces a control
that device-code flow cannot satisfy — typically "require compliant device" / "require
hybrid Azure AD joined device", or an explicit block on the device code authentication
flow. In testing, one tenant allowed it while another refused it **even from a managed,
domain-joined Windows device**, so "use a managed machine" is not a fix.

There is no way around it in code:

- The token is consumed by a container, which can never be Intune-enrolled or hybrid-joined.
- Registering your own Azure AD application does not help: the engine shells out to `az`,
  which always authenticates as the Azure CLI first-party app
  `04b07795-8ddb-461a-bbee-02f9e1bf7b46`. Entra therefore has no signal that distinguishes
  this service from any other use of the CLI by that user, which also means an exclusion
  cannot be scoped to "requests from this bridge".

If your tenant blocks it, the options are an Entra policy exclusion (scoped to that app and
a security group) or abandoning per-user identity for a single service principal, which is
not subject to device-based Conditional Access. The latter reuses everything here with the
per-user path unused, at the cost of the isolation this project exists to provide.

## Onboarding

The bridge injects one tool the engine doesn't have: **`power_automate_connect_account`**.
It starts `az login --use-device-code` detached (device-code login blocks ~15 minutes, far
longer than a tool call can wait) and returns the code and URL immediately. The user
completes it in any browser, then simply retries a normal tool.

Concurrent calls for the same user return the same code rather than racing a second `az`
process against the same token cache. Engine errors telling users to "run `az login`" are
rewritten to point at this tool; license/permission errors are deliberately left alone,
since sending those users through a login would change nothing.

## Operational notes

- **Single replica only.** Per-user state lives on a single-attach volume plus an
  in-memory session map. Do not scale beyond 1.
- **Memory** is ~75 MB per live engine child. Idle reaping (30 min default) bounds it;
  LibreChat transparently reconnects afterward, so reaping is invisible to users.
- **One engine child per session, not per user** — deliberate. The engine holds mutable
  `set_current_env`/`set_current_flow` state, so pooling would let one chat silently
  reassign another chat's working environment.
- **Image is ~1.2 GB**, dominated by the Azure CLI's bundled Python. Alpine was rejected:
  several of az's pinned deps have no musl wheels.
- Every tool call emits an audit line: `{"type":"audit","userId","tool","durationMs","ok"}`.

## Security

The HTTP endpoint proxies to a server holding live Azure credentials. It is protected by
Railway private networking (no public domain) **and** the shared secret — the secret is
what makes the `X-LibreChat-User-Id` header trustworthy, since it authenticates the caller
as LibreChat before that header is believed.

**The volume is a plaintext OAuth token store.** Azure CLI encrypts its MSAL cache only
when a platform keyring is available, and containers have none — so
`<USERS_ROOT>/<userId>/msal_token_cache.json` holds readable refresh tokens (~90-day
rolling lifetime) for every onboarded employee. This is still better than a shared
admin-level identity, since each token carries only that user's own permissions, but the
volume is a concentrated target: don't mount it elsewhere, and confirm Railway encrypts
volumes at rest.

**No offboarding automation.** When someone leaves, delete their directory under
`USERS_ROOT` — otherwise their refresh token persists until it expires.
