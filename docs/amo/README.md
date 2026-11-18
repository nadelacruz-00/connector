# Signing with addons.mozilla.org (AMO)

This fork ships as an **unlisted** (self-distributed) Firefox add-on. AMO
signs each version but does not list it publicly. Users install the signed
`.xpi` from the GitHub releases page.

## One-time setup

1. Sign in at <https://addons.mozilla.org/developers/> with a Firefox
   account.
2. Open <https://addons.mozilla.org/developers/addon/api/key/> and create
   API credentials.
3. In the GitHub repository: **Settings → Secrets and variables →
   Actions → New repository secret**:
   - `AMO_JWT_ISSUER` = the "JWT issuer" value
   - `AMO_JWT_SECRET` = the "JWT secret" value

Do not commit these values.

The first signed upload creates the add-on on AMO under the id in
`src/manifest.ts` (`browser_specific_settings.gecko.id`). Do not change
that id later: Firefox treats a new id as a different add-on, and users
lose their paired origins.

## Sign locally (optional)

```bash
pnpm build
WEB_EXT_API_KEY=... WEB_EXT_API_SECRET=... pnpm sign
```

The signed `.xpi` goes to `web-ext-artifacts/`.

## Rules to remember

- AMO signs each version number only once. Bump `version` in
  `package.json` before each release.
- Unlisted add-ons are usually auto-approved in minutes. AMO can still
  review the add-on later.
- `pnpm lint:ext` runs the same linter as AMO. Fix every error before you
  tag a release.
- The manifest declares `data_collection_permissions: authenticationInfo`
  (Firefox built-in data consent). Keep it in step with what the add-on
  does with data.
