// demeu-mis-file:v1. Mirror the strict runtime credential-file schema, no output.
const fs = process.getBuiltinModule("node:fs");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
try {
  const path = process.argv[1];
  const info = fs.lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 1000000) process.exit(1);
  const bytes = fs.readFileSync(path);
  if (bytes.length > 1000000) process.exit(1);
  const state = JSON.parse(bytes.toString("utf8"));
  if (!exact(state, ["schemaVersion", "integrations"]) || state.schemaVersion !== 1 || !Array.isArray(state.integrations)) process.exit(1);
  const integrations = new Set(), credentials = new Set(), organizations = new Set();
  for (const entry of state.integrations) {
    if (!exact(entry, ["integrationId", "organizationId", "enabled", "keys"]) || !identifier(entry.integrationId)
      || integrations.has(entry.integrationId) || !identifier(entry.organizationId) || typeof entry.enabled !== "boolean"
      || !Array.isArray(entry.keys) || !entry.keys.length || entry.enabled && organizations.has(entry.organizationId)) process.exit(1);
    integrations.add(entry.integrationId);
    if (entry.enabled) organizations.add(entry.organizationId);
    for (const key of entry.keys) {
      if (!exact(key, ["credentialId", "secretHash", "enabled", "scopes", "expiresAt"]) || !identifier(key.credentialId)
        || credentials.has(key.credentialId) || typeof key.secretHash !== "string" || !/^sha256\$[a-f0-9]{64}$/.test(key.secretHash)
        || typeof key.enabled !== "boolean" || !Array.isArray(key.scopes) || !key.scopes.length
        || new Set(key.scopes).size !== key.scopes.length || !key.scopes.every((scope) => ["events:pull", "events:ack", "events:research"].includes(scope))
        || !(key.expiresAt === null || Number.isSafeInteger(key.expiresAt) && key.expiresAt >= 0)) process.exit(1);
      credentials.add(key.credentialId);
    }
  }
} catch { process.exit(1); }
