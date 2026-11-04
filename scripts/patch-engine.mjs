#!/usr/bin/env node
// Patches the vendored engine bundle in place. The Dockerfile runs it, so only the image is
// patched: vendor/mcp.mjs in git stays an unmodified copy of Microsoft's bundle.
//
// The engine gets connection-management tokens (resource https://api.powerplatform.com) from
// its own interactive MSAL browser sign-in, never from `az`, because the real Azure CLI is not
// preauthorized for that API. In a container no browser exists, so every connection tool
// failed. The patch adds a switch: with FLOWAGENT_CONNECTIVITY_VIA_AZ set (the bridge sets it
// in production), that resource goes through `az` like every other one, so bin/az serves it
// with an On-Behalf-Of token. Unset, the engine behaves exactly as upstream, which keeps dev
// mode's browser sign-in working.
//
// Usage: node scripts/patch-engine.mjs [path/to/mcp.mjs]
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? new URL('../vendor/mcp.mjs', import.meta.url).pathname;

// From buildCompositeAuth (packages/core/dist/auth/composite-auth.js in the bundle).
const ANCHOR =
  'const isConnectivityResource = (resource) => resource === connectivityResource || resource === CONNECTIVITY_RESOURCE_COMMERCIAL;';
const PATCHED =
  'const isConnectivityResource = (resource) => !process.env.FLOWAGENT_CONNECTIVITY_VIA_AZ && (resource === connectivityResource || resource === CONNECTIVITY_RESOURCE_COMMERCIAL);';

const source = readFileSync(file, 'utf8');
const found = source.split(ANCHOR).length - 1;
if (found !== 1) {
  console.error(
    `patch-engine: expected the connectivity routing line exactly once in ${file}, found ${found}. ` +
      'The engine changed: re-check buildCompositeAuth and update this patch.',
  );
  process.exit(1);
}
writeFileSync(file, source.replace(ANCHOR, PATCHED));
console.log(`patch-engine: ${file} now routes api.powerplatform.com through az when FLOWAGENT_CONNECTIVITY_VIA_AZ is set`);
