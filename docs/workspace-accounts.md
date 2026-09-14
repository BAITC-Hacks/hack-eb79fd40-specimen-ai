# Workspace accounts

The workspace is separate from the public patient chat. Operators configure accounts; there is no registration screen or shared-code shortcut. `DOCTOR_ACCESS_CODE` does not establish a workspace identity.

Set all three server variables to enable it:

- `DEMEU_ACCOUNTS_FILE`: explicit path to an operator-managed JSON file outside the repository and public directories.
- `DEMEU_AUTH_SECRET`: independent random signing secret of at least 32 UTF-8 bytes; keep it out of source control.
- `DEMEU_DATA_DIR`: persistent application storage directory, configured and mounted by the operator.

`workspaceConfigured()` detects even partial auth configuration so callers cannot fall back to legacy access or global Telegram delivery. An existing `referrals.json` in `DEMEU_DATA_DIR` also keeps workspace protection active if both auth variables are removed. Permission or IO errors checking that marker fail closed. Missing counterparts, an invalid signing secret, malformed accounts, or an unreadable account file fail with `503 WORKSPACE_UNAVAILABLE`. With neither auth variable configured and no existing workspace snapshot, `GET /api/workspace/auth` returns `{ "enabled": false, "actor": null }`.

Reopening a workspace volume requires its auth configuration. Returning to legacy mode requires an explicitly isolated fresh directory or a separate deployment; removing the auth variables never migrates owned records into public access. The application does not delete the original data or marker to disable protection.

Account file shape:

```json
{
  "accounts": [
    {
      "id": "doctor-1",
      "displayName": "Врач 1",
      "role": "doctor",
      "organizationId": "clinic-1",
      "passwordHash": "<generated scrypt hash>",
      "sessionVersion": 1,
      "telegramChatId": "<optional numeric recipient>"
    }
  ]
}
```

Replace placeholders before enabling. IDs are stable ASCII identifiers, unique across accounts; roles are exactly `doctor`, `owner`, or `analyst`. Do not reuse a deleted account ID for another person. `organizationId` defines the access boundary; an owner belongs to one organization. The optional Telegram recipient is server managed, never supplied by the patient. Omit the property when unavailable. Keep the file private (for example, mode `0600`) and update it atomically. This iteration does not create or deploy real accounts.

Passwords use Node's scrypt with a random 16-byte salt, N=16384, r=8, p=1, and a 64-byte key. Stored format is `scrypt$16384$8$1$<salt hex>$<key hex>`. Generate a hash with `npx tsx scripts/hash-workspace-password.ts`, supplying one password line through stdin. The helper rejects command-line passwords and interactive terminal stdin; it prints only the resulting hash. Use a password manager's stdin integration or a protected temporary input file with shell redirection. Do not put the password in an argument, shell history, or a committed fixture. Generation requires at least 12 characters and at most 1024 UTF-8 bytes.

`POST /api/workspace/auth` accepts JSON `{ "id": "doctor-1", "password": "..." }` and returns `{ actor }`. The actor contains only `id`, `displayName`, `role`, `organizationId`, and optional `telegramChatId`. Password hashes and session versions are never returned. `GET` returns `{ enabled, actor }`, with `actor: null` when no valid session exists. `DELETE` clears the browser cookie and returns `{ "ok": true }`.

Cookies expire after eight hours. They contain a signed account ID, expiry in epoch seconds, and session version. They are HttpOnly, SameSite=Strict, Path=/; production uses Secure and the `__Host-demeu_workspace` name without a Domain attribute. Development uses `demeu_workspace` to support local HTTP. Roles and membership are loaded from the account file on every authentication check. Increment `sessionVersion` to revoke existing cookies after a password change or incident; deleting an account also revokes it. Logout clears the current browser cookie, but a separately copied signed cookie remains valid until expiry or server-side version revocation. Changing the signing secret revokes all cookies.

Mutating requests must carry an Origin matching the configured `APP_BASE_URL` origin. In production this base URL is required; only development may derive it from the request URL. Every response is `Cache-Control: no-store`. Login request bodies are limited to 4096 bytes and attempts use a separate in-memory IP token bucket with ten initial requests and one replenished token per six seconds. Trusted ingress must replace incoming X-Forwarded-For; the supplied nginx template does so. These limits apply per process, not across replicas.

Account configuration is sensitive operational data. No default accounts, default passwords, production rollout, or automatic role assignment are included.
