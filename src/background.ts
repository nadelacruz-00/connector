/**
 * Background (Firefox MV3 event page).
 *
 * Coordinates the bridge flow:
 *   1. content-bridge (running on the user's Riffado origin) sends
 *      `bridge:request-connect` when the user clicks "Continue with Plaud".
 *   2. We open https://web.plaud.ai in a new focused tab and remember which
 *      Riffado tab to send the result back to.
 *   3. We watch `cookies.onChanged` and poll `cookies.get` for Plaud's
 *      `pld_ut` session cookie -- no content script runs on web.plaud.ai for this anymore
 *      (see the file-header comment on the token-capture section below for
 *      why). Once a candidate value passes shape validation, we confirm it
 *      actually authenticates against Plaud before treating the connect as
 *      done.
 *   4. On a verified token, we forward it to the originating Riffado tab
 *      and close the plaud.ai tab.
 *
 * Only one bridge request can be in flight at a time — starting a second
 * cancels the first. Keeps the model simple; the user is never juggling
 * two connect attempts.
 *
 * Firefox can suspend this event page while the user signs in to Plaud
 * (about 30 s without extension events). In-memory state and `setTimeout`
 * loops do not survive that, so the bridge state is mirrored to
 * `storage.session`, and `cookies.onChanged` (an event, so it wakes the page)
 * drives capture. When the page wakes with a live session, polling resumes.
 */

import type {
    ConnectorTokenPayload,
    PlaudRegion,
    RuntimeMessage,
    RuntimeResponse,
} from "./lib/messages";
import { getPairedOrigins, ORIGINS_STORAGE_KEY } from "./lib/storage";

interface BridgeState {
    /** Unique per connect attempt; survives a suspend via storage.session. */
    id: string;
    bridgeTabId: number;
    plaudTabId?: number;
    /** Firefox container of the plaud.ai tab; undefined = default store. */
    cookieStoreId?: string;
    startedAt: number;
}

const PENDING_STORAGE_KEY = "pendingBridge";
let pending: BridgeState | null = null;
const BRIDGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function setPending(state: BridgeState): void {
    pending = state;
    chrome.storage.session
        .set({ [PENDING_STORAGE_KEY]: state })
        .catch((err) =>
            console.warn("[riffado-connector] failed to persist bridge:", err),
        );
}

function clearPending(): void {
    pending = null;
    chrome.storage.session.remove(PENDING_STORAGE_KEY).catch(() => {});
}

/** In-memory state, or the state saved before the event page was suspended. */
async function loadPending(): Promise<BridgeState | null> {
    if (pending) return pending;
    try {
        const data = await chrome.storage.session.get(PENDING_STORAGE_KEY);
        const saved = data[PENDING_STORAGE_KEY] as BridgeState | undefined;
        // Another handler may have set `pending` while we awaited.
        if (!pending && saved && typeof saved.id === "string") pending = saved;
    } catch {
        // storage.session unavailable; nothing to restore.
    }
    return pending;
}

function isCurrent(session: BridgeState): boolean {
    return pending?.id === session.id;
}

function isStale(state: BridgeState): boolean {
    return Date.now() - state.startedAt > BRIDGE_TTL_MS;
}

// Firefox-only fields that @types/chrome does not declare.
type FirefoxTab = chrome.tabs.Tab & { cookieStoreId?: string };

// ---------------------------------------------------------------------------
// Dynamic bridge registration for paired self-hosted origins.
//
// The bridge content script is declared statically in the manifest only for
// the hosted origin (riffado.com). Self-hosted instances are paired at
// runtime via the popup, which grants host permission for the origin — but in
// MV3 granting a host permission does NOT make a statically-declared content
// script start running on a new origin. Without registering the script for
// paired origins, `window.__riffadoConnector` is never defined there and the
// app shows the "Install Riffado Connector" CTA forever.
//
// We mirror the manifest's bridge script onto every paired origin via
// chrome.scripting, reading its built path out of the runtime manifest so we
// never hardcode a bundler-hashed filename.
// ---------------------------------------------------------------------------

const DYNAMIC_BRIDGE_PREFIX = "riffado-bridge:";

// The statically-declared bridge content script (the one covering the hosted
// origin). We reuse both its built js path and its match list. It's identified
// by its source module name — the bundler emits a hashed filename that still
// contains "content-bridge", an unambiguous fingerprint. Matching on the
// riffado.com origin instead would be fragile: a future unrelated script could
// share that origin (or a `notriffado.com` match would substring-match it).
function bridgeContentScript() {
    const manifest = chrome.runtime.getManifest();
    return (manifest.content_scripts ?? []).find((cs) =>
        (cs.js ?? []).some((f) => f.includes("content-bridge")),
    );
}

function bridgeScriptFiles(): string[] {
    return bridgeContentScript()?.js ?? [];
}

// Origins already covered by the static bridge declaration. Registering these
// dynamically would double-inject the bridge (duplicate connect requests), so
// they're excluded from the dynamic set.
function staticallyCoveredOrigins(): Set<string> {
    const matches = bridgeContentScript()?.matches ?? [];
    return new Set(matches.map((m) => m.replace(/\/\*$/, "")));
}

async function reconcilePairedContentScripts(): Promise<void> {
    const js = bridgeScriptFiles();
    if (js.length === 0) return; // no bridge script in the manifest to mirror

    const covered = staticallyCoveredOrigins();
    const paired = await getPairedOrigins();
    const wanted = new Map<string, string>(); // registration id -> match glob
    for (const { origin } of paired) {
        if (covered.has(origin)) continue; // already injected statically
        wanted.set(`${DYNAMIC_BRIDGE_PREFIX}${origin}`, `${origin}/*`);
    }

    let registered: chrome.scripting.RegisteredContentScript[] = [];
    try {
        registered = await chrome.scripting.getRegisteredContentScripts();
    } catch {
        return; // scripting API unavailable; nothing to do
    }
    const ours = registered.filter((s) =>
        s.id.startsWith(DYNAMIC_BRIDGE_PREFIX),
    );

    // Drop registrations for origins the user has un-paired.
    const stale = ours.filter((s) => !wanted.has(s.id)).map((s) => s.id);
    if (stale.length > 0) {
        await chrome.scripting
            .unregisterContentScripts({ ids: stale })
            .catch(() => {});
    }

    // Register newly-paired origins we actually hold host permission for.
    const existing = new Set(ours.map((s) => s.id));
    for (const [id, matches] of wanted) {
        if (existing.has(id)) continue;
        const granted = await chrome.permissions
            .contains({ origins: [matches] })
            .catch(() => false);
        if (!granted) continue; // permission revoked out-of-band; skip
        try {
            await chrome.scripting.registerContentScripts([
                {
                    id,
                    js,
                    matches: [matches],
                    runAt: "document_start",
                    allFrames: false,
                    persistAcrossSessions: true,
                },
            ]);
        } catch (err) {
            console.warn(
                "[riffado-connector] failed to register bridge for",
                matches,
                err,
            );
        }
    }
}

// Serialize + coalesce reconciliations. onStartup, onInstalled and the
// storage.onChanged listener can all fire near-simultaneously; without this,
// two overlapping runs would compute the same "new" origins and race on
// registerContentScripts (duplicate id → thrown, then swallowed as a
// misleading "failed to register" warning). Runs are serialized; requests
// arriving mid-run collapse into a single trailing run.
let reconcileRunning = false;
let reconcileQueued = false;

async function syncPairedContentScripts(): Promise<void> {
    if (reconcileRunning) {
        reconcileQueued = true;
        return;
    }
    reconcileRunning = true;
    try {
        do {
            reconcileQueued = false;
            // Catch per pass: if one reconcile rejects (e.g. a storage read
            // throws), we must still drain any work that was coalesced during
            // it. Letting the rejection escape the loop would reset
            // reconcileRunning in `finally` while leaving reconcileQueued set,
            // silently dropping that trailing pass until an unrelated event
            // happened to trigger another sync.
            try {
                await reconcilePairedContentScripts();
            } catch (err) {
                console.warn(
                    "[riffado-connector] bridge reconciliation pass failed:",
                    err,
                );
            }
        } while (reconcileQueued);
    } finally {
        reconcileRunning = false;
    }
}

// Keep dynamic registrations in step with the paired-origins list as the
// popup adds/removes instances.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(ORIGINS_STORAGE_KEY in changes)) return;
    syncPairedContentScripts().catch((err) =>
        console.warn("[riffado-connector] content-script sync failed:", err),
    );
});

// Firefox: the popup can close while the permission prompt is open, so the
// popup's own follow-up never runs. And the user can grant or revoke host
// access in about:addons. Re-sync on every host-permission change.
chrome.permissions.onAdded.addListener(() => {
    void syncPairedContentScripts();
});
chrome.permissions.onRemoved.addListener(() => {
    void syncPairedContentScripts();
});

// ---------------------------------------------------------------------------
// Token capture via the cookies API.
//
// Plaud's web app authenticates web.plaud.ai with a `pld_ut` cookie carrying
// the long-lived user token (UT) -- and that cookie is HttpOnly. No page
// JavaScript, including a content script, can ever read an HttpOnly cookie's
// value; that's the entire point of the flag. An earlier version of this
// extension scanned localStorage for a token-shaped value instead, which was
// fundamentally unable to find it -- Plaud doesn't store the token there
// (at least not for every login method; see riffado/riffado#231 and its
// follow-ups for the debugging trail).
//
// `chrome.cookies` is a privileged extension API specifically designed to
// read cookies, including HttpOnly ones, for exactly this kind of legitimate
// session handoff. It's scoped by the existing plaud.ai `host_permissions`,
// not `<all_urls>`.
// ---------------------------------------------------------------------------

const PLAUD_UT_COOKIE_URL = "https://web.plaud.ai/";
const PLAUD_UT_COOKIE_NAME = "pld_ut";
const TOKEN_POLL_INTERVAL_MS = 750;
const TOKEN_POLL_TIMEOUT_MS = 90_000;
// If the same candidate token fails verification, don't hammer
// the cookies API/Plaud on every 750ms tick -- wait this long before
// re-attempting the unchanged value.
const RETRY_UNCHANGED_MS = 3_000;

const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// A real Plaud JWT header (minimum: `{"alg":"HS256","typ":"UT"}`) base64url-
// encodes to well over a dozen characters, and the payload/signature
// segments are longer still. These floors only need to reject
// pathologically short values, not tightly bound real tokens.
const MIN_HEADER_LEN = 10;
const MIN_PAYLOAD_LEN = 16;
const MIN_SIGNATURE_LEN = 16;

function base64UrlDecode(segment: string): string | null {
    try {
        const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        // atob is available in the background page.
        return atob(padded);
    } catch {
        return null;
    }
}

/**
 * `JWT_SHAPE_RE` alone ("three dot-separated base64url-charset segments")
 * matches far more than real JWTs -- a coincidental non-token cookie/value
 * could satisfy it trivially. Require realistic segment lengths *and* a
 * decodable JWT header (`{"alg":...}`) before treating a value as a genuine
 * token candidate. Belt-and-suspenders on top of reading a specifically-
 * named, Plaud-controlled cookie (which is a much higher-trust source than
 * the old approach of scanning arbitrary localStorage keys ever was).
 */
function looksLikeJwt(candidate: string): boolean {
    if (!JWT_SHAPE_RE.test(candidate)) return false;
    const [header, payload, signature] = candidate.split(".");
    if (
        header.length < MIN_HEADER_LEN ||
        payload.length < MIN_PAYLOAD_LEN ||
        signature.length < MIN_SIGNATURE_LEN
    ) {
        return false;
    }
    const decodedHeader = base64UrlDecode(header);
    if (!decodedHeader) return false;
    try {
        const parsed = JSON.parse(decodedHeader) as { alg?: unknown };
        return typeof parsed.alg === "string";
    } catch {
        return false;
    }
}

function decodeJwtRegion(token: string): string | null {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const decoded = base64UrlDecode(parts[1]);
        if (!decoded) return null;
        const claims = JSON.parse(decoded) as { region?: unknown };
        return typeof claims.region === "string" ? claims.region : null;
    } catch {
        return null;
    }
}

function apiBaseFromAwsRegion(awsRegion: string): string | null {
    switch (awsRegion) {
        case "aws:us-west-2":
            return "https://api.plaud.ai";
        case "aws:eu-central-1":
            return "https://api-euc1.plaud.ai";
        case "aws:ap-southeast-1":
            return "https://api-apse1.plaud.ai";
        default:
            return null;
    }
}

function hostToRegion(host: string): PlaudRegion {
    if (host === "api.plaud.ai") return "global";
    if (host === "api-euc1.plaud.ai") return "euc1";
    if (host === "api-apse1.plaud.ai") return "apse1";
    return "unknown";
}

/**
 * Region is derived from the token's own `region` claim -- every real token
 * we've inspected carries it (`"region":"aws:eu-central-1"`, etc.), and
 * decoding it here needs no content script or localStorage access. Defaults
 * to global if the claim is missing or unrecognized.
 */
function resolveApiBaseFromToken(token: string): {
    apiBase: string;
    region: PlaudRegion;
} {
    const awsRegion = decodeJwtRegion(token);
    if (awsRegion) {
        const fromJwt = apiBaseFromAwsRegion(awsRegion);
        if (fromJwt) {
            return {
                apiBase: fromJwt,
                region: hostToRegion(new URL(fromJwt).hostname),
            };
        }
        console.debug(
            `[riffado-connector] unknown JWT region '${awsRegion}', defaulting to global`,
        );
    }
    return { apiBase: "https://api.plaud.ai", region: "global" };
}

async function getPlaudUtCookie(storeId?: string): Promise<string | null> {
    try {
        const details: chrome.cookies.CookieDetails = {
            url: PLAUD_UT_COOKIE_URL,
            name: PLAUD_UT_COOKIE_NAME,
        };
        // Read from the container the plaud.ai tab runs in. Without a
        // storeId Firefox reads the default container only.
        if (storeId) details.storeId = storeId;
        const cookie = await chrome.cookies.get(details);
        return cookie?.value ?? null;
    } catch (err) {
        console.warn("[riffado-connector] cookies.get failed:", err);
        return null;
    }
}

/**
 * Open web.plaud.ai in the same Firefox container as the Riffado tab, so a
 * user who keeps Plaud signed in inside a container gets that session. Falls
 * back to the default container if Firefox refuses (for example a private
 * window store used from a normal window).
 */
async function openPlaudTab(bridgeTabId: number): Promise<FirefoxTab> {
    let cookieStoreId: string | undefined;
    try {
        const bridgeTab = (await chrome.tabs.get(bridgeTabId)) as FirefoxTab;
        cookieStoreId = bridgeTab.cookieStoreId;
    } catch {
        // Bridge tab gone; open in the default container.
    }
    const props: chrome.tabs.CreateProperties & { cookieStoreId?: string } = {
        url: "https://web.plaud.ai/",
        active: true,
    };
    if (cookieStoreId) {
        try {
            return (await chrome.tabs.create({
                ...props,
                cookieStoreId,
            } as chrome.tabs.CreateProperties)) as FirefoxTab;
        } catch (err) {
            console.warn(
                "[riffado-connector] could not open Plaud in the Riffado tab's container:",
                err,
            );
        }
    }
    return (await chrome.tabs.create(props)) as FirefoxTab;
}

// Retry bookkeeping for the current session, shared by the poll loop and the
// cookies.onChanged listener so they never verify the same unchanged value
// back to back or deliver twice.
let lastAttempted: string | null = null;
let lastAttemptAt = 0;
let attemptInFlight = false;
let pollingSessionId: string | null = null;

async function startBridge(bridgeTabId: number): Promise<void> {
    // Cancel any prior bridge request — we only support one at a time.
    const prior = await loadPending();
    if (prior?.plaudTabId !== undefined) {
        try {
            await chrome.tabs.remove(prior.plaudTabId);
        } catch {
            // Tab may already be gone. Ignore.
        }
    }

    const tab = await openPlaudTab(bridgeTabId);

    const session: BridgeState = {
        id: crypto.randomUUID(),
        bridgeTabId,
        plaudTabId: tab.id,
        cookieStoreId: tab.cookieStoreId,
        startedAt: Date.now(),
    };
    lastAttempted = null;
    lastAttemptAt = 0;
    setPending(session);

    void pollForToken(session);
}

/**
 * Verify and deliver one candidate token. Returns true when the session is
 * done (token delivered).
 */
async function tryToken(
    session: BridgeState,
    token: string,
): Promise<boolean> {
    if (!looksLikeJwt(token) || attemptInFlight) return false;
    const changed = token !== lastAttempted;
    const dueForRetry = Date.now() - lastAttemptAt > RETRY_UNCHANGED_MS;
    if (!changed && !dueForRetry) return false;

    attemptInFlight = true;
    lastAttempted = token;
    lastAttemptAt = Date.now();
    try {
        const { apiBase, region } = resolveApiBaseFromToken(token);
        const payload: ConnectorTokenPayload = {
            accessToken: token,
            apiBase,
            region,
            capturedAt: Date.now(),
        };
        return await deliverTokenToBridge(session, payload);
    } finally {
        attemptInFlight = false;
    }
}

async function pollForToken(session: BridgeState): Promise<void> {
    if (pollingSessionId === session.id) return; // already polling this one
    pollingSessionId = session.id;
    try {
        const deadline = session.startedAt + TOKEN_POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            // This attempt was superseded by a new startBridge() / cancelled.
            if (!isCurrent(session)) return;

            const token = await getPlaudUtCookie(session.cookieStoreId);
            if (token && (await tryToken(session, token))) return;

            await new Promise((r) => setTimeout(r, TOKEN_POLL_INTERVAL_MS));
        }
        console.debug(
            "[riffado-connector] poll timed out; still listening for cookie changes",
        );
    } finally {
        if (pollingSessionId === session.id) pollingSessionId = null;
    }
}

// Event-driven capture. Unlike the poll loop, this listener survives an
// event-page suspend: Firefox wakes the page to deliver the event.
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
    if (removed || cookie.name !== PLAUD_UT_COOKIE_NAME) return;
    if (!/(^|\.)plaud\.ai$/.test(cookie.domain.replace(/^\./, ""))) return;
    void (async () => {
        const session = await loadPending();
        if (!session) return;
        if (isStale(session)) {
            clearPending();
            return;
        }
        if (session.cookieStoreId && cookie.storeId !== session.cookieStoreId) {
            return; // a different container's Plaud login
        }
        if (await tryToken(session, cookie.value)) return;
        // Not verified yet: make sure the poll runs again after a wake-up.
        void pollForToken(session);
    })();
});

/**
 * Confirm a captured token actually authenticates against Plaud before we
 * hand it to the bridge and close the plaud.ai tab.
 *
 * `/team-app/workspaces/list` is the same endpoint the Riffado server uses
 * to validate a freshly connected token, so "verified here" and "verified
 * server-side" agree (confirmed by directly comparing responses: a real
 * token succeeds against this endpoint regardless of request Origin, so
 * there's no CORS/origin obstacle to calling it from the background).
 * `apiBase` is constrained to the hosts covered by `host_permissions` (see
 * `isPermittedApiHost`), which this function double-checks before fetching.
 */
const VERIFY_TIMEOUT_MS = 8_000;

function isPermittedApiHost(apiBase: string): boolean {
    try {
        const origin = new URL(apiBase).origin;
        const granted: string[] =
            chrome.runtime.getManifest().host_permissions ?? [];
        return granted.some((pattern: string) => {
            try {
                return new URL(pattern).origin === origin;
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}

async function verifyPlaudToken(
    accessToken: string,
    apiBase: string,
): Promise<boolean> {
    if (!isPermittedApiHost(apiBase)) {
        console.warn(
            `[riffado-connector] apiBase '${apiBase}' isn't covered by host_permissions; refusing to verify`,
        );
        return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
        const res = await fetch(
            `${apiBase}/team-app/workspaces/list?need_personal_workspace=true`,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                signal: controller.signal,
            },
        );
        if (!res.ok) return false;
        const body = (await res.json().catch(() => null)) as {
            status?: number;
            data?: { workspaces?: unknown[] };
        } | null;
        return body?.status === 0 && Array.isArray(body.data?.workspaces);
    } catch {
        // Network error, timeout, Plaud unreachable, or a malformed body --
        // treat as "not verified yet" rather than surfacing an error. The
        // caller keeps polling and will retry against a later (hopefully
        // settled) capture instead of failing the whole connect attempt on
        // a blip.
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Returns whether the token was verified and delivered. `false` means the
 * caller should keep the plaud.ai tab open and keep polling -- the token
 * captured so far doesn't authenticate yet.
 */
async function deliverTokenToBridge(
    session: BridgeState,
    payload: ConnectorTokenPayload,
): Promise<boolean> {
    if (!isCurrent(session)) return false;
    if (isStale(session)) {
        clearPending();
        return false;
    }

    const verified = await verifyPlaudToken(payload.accessToken, payload.apiBase);
    if (!verified) return false;

    // The session was replaced or cancelled while we were verifying. This
    // capture no longer belongs to the active attempt; drop it silently
    // rather than acting on state that isn't ours.
    if (!isCurrent(session)) return false;

    const { bridgeTabId, plaudTabId } = session;

    try {
        await chrome.tabs.sendMessage(bridgeTabId, {
            type: "plaud:token-captured",
            payload,
        } satisfies RuntimeMessage);
    } catch (err) {
        // Bridge tab might have been closed or navigated. Nothing useful we
        // can do; surface in the console for debugging.
        console.warn("[riffado-connector] bridge tab unreachable:", err);
    }

    // Close the plaud.ai tab now that we've harvested what we needed.
    if (plaudTabId !== undefined) {
        try {
            await chrome.tabs.remove(plaudTabId);
        } catch {
            // Tab may already be gone.
        }
    }

    clearPending();
    return true;
}

chrome.runtime.onMessage.addListener(
    (
        msg: RuntimeMessage,
        sender,
        sendResponse: (resp: RuntimeResponse) => void,
    ) => {
        if (msg.type === "bridge:request-connect") {
            const tabId = msg.bridgeTabId ?? sender.tab?.id;
            if (typeof tabId !== "number") {
                sendResponse({
                    ok: false,
                    error: "could not determine originating tab id",
                });
                return false;
            }
            startBridge(tabId).then(
                () => sendResponse({ ok: true }),
                (err: unknown) =>
                    sendResponse({
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    }),
            );
            return true; // async response
        }

        if (msg.type === "bridge:cancel") {
            void loadPending().then((session) => {
                const plaudTabId = session?.plaudTabId;
                clearPending();
                if (plaudTabId !== undefined) {
                    chrome.tabs.remove(plaudTabId).catch(() => {});
                }
            });
            sendResponse({ ok: true });
            return false;
        }

        return false;
    },
);

// Runs every time Firefox (re)starts this event page, including a wake-up in
// the middle of a connect attempt: drop a stale session or resume polling.
void loadPending().then((session) => {
    if (!session) return;
    if (isStale(session)) {
        clearPending();
        return;
    }
    void pollForToken(session);
});

// Reconcile bridge registrations in case the paired-origins list changed
// while the browser was closed.
chrome.runtime.onStartup.addListener(() => {
    void syncPairedContentScripts();
});

// Register the bridge for already-paired origins on install/update (dynamic
// registrations declared with persistAcrossSessions survive, but reconciling
// here covers upgrades from a version that never registered them at all).
chrome.runtime.onInstalled.addListener((details) => {
    void syncPairedContentScripts();

    // First-run onboarding: open the welcome tab once on fresh install. We
    // intentionally do NOT open it on update or browser_update so we don't
    // nag returning users every time they get a new version.
    if (details.reason !== "install") return;
    chrome.tabs
        .create({ url: chrome.runtime.getURL("src/welcome.html") })
        .catch((err) => {
            console.warn(
                "[riffado-connector] failed to open welcome tab:",
                err,
            );
        });
});
