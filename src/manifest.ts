import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

/**
 * MV3 manifest (Firefox).
 *
 * Firefox runs MV3 backgrounds as an event page (`background.scripts`), not
 * a service worker. `browser_specific_settings.gecko` sets the add-on id
 * (needed for AMO signing and for storage to survive reinstalls) and the
 * minimum version: 140 (ESR) is the first release that supports
 * `data_collection_permissions` (Firefox built-in data consent), and it
 * has every MV3 API used here (`scripting.registerContentScripts`,
 * `storage.session`, `cookies.get({ storeId })` for container tabs).
 *
 * Permission posture (kept minimal on purpose; the README's security section
 * explains each entry):
 *
 *   - `host_permissions`:
 *       - https://*.plaud.ai/*  — read the access token a logged-in user's
 *         browser has already obtained from Plaud's own site.
 *       - https://riffado.com/*  — talk to Riffado's hosted instance.
 *     Self-hosted users grant their own origin via `optional_host_permissions`
 *     through the popup ("Add my Riffado URL").
 *
 *   - `permissions`:
 *       - storage  — remember the user's self-hosted origins between sessions.
 *       - tabs     — open web.plaud.ai in a new tab and close it once the
 *                    token has been captured and verified.
 *       - scripting — register the bridge content script for self-hosted
 *                    origins paired at runtime (see background.ts). The
 *                    statically-declared bridge below only covers the
 *                    hosted origin.
 *       - cookies  — read Plaud's `pld_ut` session cookie, which carries
 *                    the long-lived user token. That cookie is HttpOnly,
 *                    so no page JavaScript (including a content script)
 *                    can ever read it via `document.cookie`; `cookies`
 *                    is the only way to obtain its value, and it's the
 *                    intended API for exactly this kind of session
 *                    handoff. Scoped by the plaud.ai `host_permissions`
 *                    above, not `<all_urls>`.
 *
 *   - No `webRequest`, no `<all_urls>`.
 */
export default defineManifest({
    manifest_version: 3,
    name: "Riffado Connector",
    short_name: "Riffado",
    description: pkg.description,
    version: pkg.version,
    homepage_url: pkg.homepage,
    icons: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        96: "icons/icon-96.png",
        128: "icons/icon-128.png",
    },
    action: {
        default_popup: "src/popup.html",
        default_title: "Riffado Connector",
        default_icon: {
            16: "icons/icon-16.png",
            32: "icons/icon-32.png",
        },
    },
    background: {
        scripts: ["src/background.ts"],
        type: "module",
    },
    browser_specific_settings: {
        gecko: {
            id: "riffado-connector@nadelacruz-00.github.io",
            strict_min_version: "140.0",
            // The add-on reads the user's Plaud session token and hands it to
            // the user's own Riffado page. AMO requires this declaration for
            // new add-ons (Firefox built-in data consent).
            data_collection_permissions: {
                required: ["authenticationInfo"],
            },
        },
    },
    // `scripting` lets the background register the bridge content script
    // for self-hosted origins the user pairs at runtime (see background.ts).
    // The statically-declared bridge below only covers the hosted origin;
    // granting a host permission alone never starts a declared content script
    // on a new origin, so paired instances need explicit registration.
    // `cookies` lets the background read Plaud's HttpOnly `pld_ut`
    // session cookie directly -- see the file-header comment above.
    permissions: ["storage", "tabs", "scripting", "cookies"],
    host_permissions: [
        "https://api.plaud.ai/*",
        "https://api-euc1.plaud.ai/*",
        "https://api-apse1.plaud.ai/*",
        "https://web.plaud.ai/*",
        "https://riffado.com/*",
    ],
    // Self-hosted Riffado is commonly run on a LAN or localhost over plain
    // HTTP (e.g. http://192.168.1.107:3000) to drive a local Ollama. We grant
    // those origins on demand via the popup, so both schemes are allowed here.
    optional_host_permissions: ["https://*/*", "http://*/*"],
    // No content script runs on web.plaud.ai anymore -- token capture reads
    // the pld_ut cookie directly from the background event page via
    // the cookies API (see background.ts), which is the only thing that can
    // read an HttpOnly cookie's value at all.
    content_scripts: [
        {
            matches: ["https://riffado.com/*"],
            js: ["src/content-bridge.ts"],
            run_at: "document_start",
            all_frames: false,
        },
    ],
    web_accessible_resources: [
        {
            resources: ["page-bridge.js"],
            matches: ["<all_urls>"],
        },
    ],
});
