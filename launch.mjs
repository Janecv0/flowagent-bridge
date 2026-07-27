#!/usr/bin/env node
// The vendored FlowAgent engine (vendor/mcp.mjs) is an esbuild ESM bundle whose
// __require shim throws on any dynamic require — including Node builtins like
// "buffer", which inlined CommonJS deps (safe-buffer -> jws -> jsonwebtoken)
// still reach for at load time. In an ES module `require` is not a binding, so
// the shim's `typeof require !== "undefined"` check falls through to the global
// scope. Defining it there satisfies the shim without patching the vendored
// bundle, which is regenerated upstream by `npm run build`.
//
// This is an upstream bug — `node vendor/mcp.mjs` fails on a clean checkout — so
// re-verify this shim still works whenever a newer engine bundle is re-vendored.
import { createRequire } from 'node:module';

globalThis.require = createRequire(import.meta.url);

await import(new URL('./vendor/mcp.mjs', import.meta.url).href);
