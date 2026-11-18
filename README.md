# Riffado Connector for Firefox

Tiny Firefox add-on that bridges your Plaud session to your
[Riffado](https://github.com/riffado/riffado) instance.

> This is a Firefox port of
> [riffado/connector](https://github.com/riffado/connector) (a Chrome
> extension). The bridge protocol (`window.__riffadoConnector`, version 1)
> is the same, so Riffado works with either one.

It exists because Plaud's email-OTP login signs you into a different
account than Plaud's Google or Apple sign-in (see
[riffado/riffado#65](https://github.com/riffado/riffado/issues/65)).
Real Sign in with Google / Apple from inside Riffado is structurally
blocked by Google's authorized-origins policy on Plaud's OAuth client.
The connector solves that by letting you sign in to `web.plaud.ai`
normally and then forwarding the resulting access token to Riffado.

The token is the same long-lived (~300 day) JWT Plaud's own web app uses.
Riffado encrypts it at rest with AES-256-GCM.

---

## Install

Requires Firefox 140 or later (desktop; 140 is the current ESR).

### Signed `.xpi` from a GitHub release — recommended

1. Open the [latest release](https://github.com/nadelacruz-00/connector/releases/latest)
   in Firefox.
2. Click `riffado-connector-<version>.xpi`. Firefox asks to install the
   add-on and shows its permissions; click **Add**.

The add-on is signed by Mozilla as an unlisted (self-distributed) add-on,
so it installs in normal Firefox and stays installed across restarts.
After install you'll see a welcome tab with three steps. Click
**Open riffado.com**, then **Continue with Plaud**, sign in to Plaud as
you normally would (Google, Apple, or email), and you're done.

> Self-distributed add-ons don't auto-update yet. To get a newer version,
> install the newer `.xpi` from the releases page; Firefox replaces the
> old one and keeps your paired origins.

### Temporary install (development)

1. `pnpm install && pnpm build`
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on…** → select `dist/manifest.json`.

Temporary add-ons are removed when Firefox closes.

### If the add-on lost access to Plaud

Firefox lets you turn host permissions off in `about:addons` →
Riffado Connector → **Permissions**. If the `plaud.ai` sites are off, the
popup and the welcome page show a **Grant access** button. Click it and
accept the prompt.

### Firefox containers

**Continue with Plaud** opens `web.plaud.ai` in the same container as
your Riffado tab and reads the Plaud cookie from that container. So if
you keep Plaud signed in inside a container, open Riffado in that
container too.

---

## How it works

1. On the Riffado connect screen, the page detects
   `window.__riffadoConnector` (injected by this extension) and shows a
   **Continue with Plaud** button.
2. Clicking it asks the extension to open `https://web.plaud.ai/` in a
   new tab.
3. You sign in there however you normally do — Google, Apple, or
   email/password. The extension does not see your password and does not
   interact with Google or Apple.
4. Once Plaud has issued you a session, the extension reads your access
   token from Plaud's own `pld_ut` cookie (via the `cookies` API, the only
   API that can read it — it's `HttpOnly`, so no page script ever could),
   confirms it actually authenticates against Plaud, closes the Plaud tab,
   and hands the token to the Riffado tab.
5. The Riffado page POSTs the token to its own
   `/api/plaud/auth/connect-token` endpoint with your existing Riffado
   session cookie. Done.

The connector itself **never sends data to anything other than your
Riffado instance**. There is no backend; everything happens in your
browser. Privacy policy:
<https://riffado.com/privacy/connector>.

---

## Permissions and what they're for

| Permission | Why |
| --- | --- |
| `storage` | Remember which self-hosted Riffado origins you've paired (`storage.local`), and keep the in-progress connect attempt across event-page suspends (`storage.session`, cleared when Firefox closes; never holds the token). |
| `tabs` | Open `web.plaud.ai` in a new tab (in the Riffado tab's container) and close it after capture; open the welcome tab on first install. |
| `scripting` | Register the bridge on self-hosted origins paired at runtime (the hosted origin's bridge is declared statically instead). |
| `cookies` | Read Plaud's `pld_ut` session cookie, which carries your access token. That cookie is `HttpOnly` — no page JavaScript, including a content script, can read it via `document.cookie`; `chrome.cookies` is the only API that can. Scoped by the `host_permissions` below, not `<all_urls>`. |
| `host_permissions: web.plaud.ai, api*.plaud.ai` | Open the login tab, read the token cookie, and verify it against Plaud before treating a connect as done. |
| `host_permissions: riffado.com` | Inject the bridge into the hosted Riffado app. |
| `optional_host_permissions: https://*/*, http://*/*` | Self-hosted instances can be paired at runtime via the popup (HTTP is allowed for LAN/localhost deployments). Each one prompts you separately. |

Not used: `webRequest`, `<all_urls>` content scripts, anything
Google/Apple-related.

The manifest also declares Firefox's built-in data consent
(`data_collection_permissions: authenticationInfo`), because the add-on
passes your Plaud session token to the Riffado page you choose.

---

## Self-hosted

If you self-host Riffado at, say, `https://my-plaud.example.com`:

1. Install the add-on.
2. On the welcome page (or by clicking the toolbar icon) → enter your
   URL → **Add**.
3. Approve the per-origin permission prompt.
4. Open your Riffado connect screen and click **Continue with Plaud**.

You can remove a paired origin from the popup; the add-on revokes the
corresponding host permission at the same time.

In Firefox the permission prompt can close the popup. The popup saves the
origin before it asks, and the background registers the bridge as soon
as the permission is granted, so this is safe. If you denied the prompt,
the origin shows a **Grant access** button; click it or **Remove**.

---

## Architecture (one screen)

```
┌──────────────────────────┐    chrome.runtime    ┌───────────────────────────┐
│  content-bridge.ts       │ ───────────────────▶ │  background.ts            │
│  (your Riffado origin) │                      │  (event page)             │
│                          │                      │                           │
│  injects ↓               │                      │  - opens web.plaud.ai     │
│                          │                      │  - watches cookies API    │
│  page-bridge.ts          │                      │    for the pld_ut cookie  │
│  (page main world)       │                      │  - verifies the token     │
│                          │                      │    against Plaud          │
│  exposes:                │                      │  - forwards it back +     │
│  window.__riffado        │                      │    closes the plaud tab   │
│      Connector.connect() │                      └─────────────┬─────────────┘
│                          │ ◀─── tab message ─── ┘
└──────────────────────────┘
            │                     cookies.get()/onChanged read Plaud's HttpOnly
            │ Promise<{ accessToken, apiBase }>   pld_ut cookie directly --
            │                     no content script runs on web.plaud.ai at all.
            ▼
┌──────────────────────────┐
│  Riffado page          │
│  POST /api/plaud/auth/   │
│       connect-token      │
│  (session cookie)        │
└──────────────────────────┘
```

The connector is a courier, not a server. It carries one short-lived
secret across two tabs the same browser already trusts.

An earlier version scanned `localStorage` on `web.plaud.ai` for a
token-shaped value via an injected content script. That approach could
never reliably find the real token: Plaud authenticates the web app with
an `HttpOnly` cookie, which by definition no page JavaScript can read.
The `cookies` API is the correct, intended API for this.

Firefox runs the MV3 background as an event page that it can suspend
after about 30 seconds without extension events, which is shorter than a
slow Plaud sign-in. So the connect attempt is saved in `storage.session`,
and `cookies.onChanged` (an event, which wakes the page) drives capture;
the 750 ms poll is a fallback that resumes on every wake-up.

---

## Security model

Threats considered:

- **Random sites scraping the bridge.** The page-bridge is only injected
  into origins listed in `host_permissions` (or runtime-granted). Other
  origins never see `window.__riffadoConnector`.
- **A paired Riffado origin trying to read my Plaud password.** It
  can't. The connector never sees your password — it only reads the
  post-login access token from Plaud's own page. A malicious Riffado
  origin you've paired could call `connect()` and try to capture the
  token, but you've already granted that origin the right to receive
  tokens by pairing it. Don't pair origins you don't control.
- **A captured value that isn't actually a working token.** Before
  treating a connect as done, the background verifies the captured
  token against Plaud's own API (`/team-app/workspaces/list`) -- the same
  check Riffado's server runs when it stores the connection. A stale or
  malformed value never reaches your Riffado instance.
- **Plaud changing their token storage shape.** The connector currently
  reads the `pld_ut` cookie via the `cookies` API. If Plaud renames or
  restructures it, we ship a connector update.
- **Token in flight.** Stays inside one browser; never crosses our
  infrastructure. From `web.plaud.ai`'s cookie jar → background →
  your Riffado tab → your Riffado server, all over local IPC except the
  final POST which is HTTPS to a host you chose.

---

## Development

```bash
pnpm install
pnpm build        # type-check + production build into dist/
pnpm start        # web-ext run: start Firefox with dist/ loaded
pnpm lint:ext     # web-ext lint (the same checks AMO runs)
pnpm zip          # unsigned zip in dist-zip/ (for about:debugging)
pnpm sign         # sign dist/ as an unlisted add-on (needs AMO API keys)
pnpm release      # build + lint + zip
```

Rebuild and reload after each change: `pnpm start` reloads the add-on
when `dist/` changes, so run `pnpm build` again in another terminal.

### Cutting a release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
   AMO refuses to sign a version number it has already signed.
2. Tag the commit `vX.Y.Z` and push the tag.

The [release workflow](.github/workflows/release.yml) type-checks,
builds, runs `web-ext lint`, signs the add-on through AMO as unlisted,
and attaches the signed `.xpi` to the GitHub release.

One-time setup: create API credentials at
<https://addons.mozilla.org/developers/addon/api/key/> and add them to the
repository as the secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. See
[`docs/amo/README.md`](./docs/amo/README.md).

---

## License

AGPL-3.0. Same license as the parent
[Riffado](https://github.com/riffado/riffado) project.
