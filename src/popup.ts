/**
 * Popup entrypoint.
 *
 * Lets the user pair self-hosted Riffado instances. For each added origin
 * we request host permission at runtime so the bridge content script
 * starts running there. Removing an origin revokes that permission too.
 *
 * Firefox notes:
 *   - The permission prompt can close the popup before `permissions.request`
 *     resolves. So we store the origin first and only drop it again on an
 *     explicit "deny". If the popup dies after a grant, the background picks
 *     the origin up through `permissions.onAdded`.
 *   - The user can revoke host access in about:addons. Origins without access
 *     show a "Grant access" button, and a banner appears when the plaud.ai
 *     hosts are missing.
 */

import {
    hasOriginAccess,
    hasRequiredHostAccess,
    requestHostAccess,
    requestOriginAccess,
    revokeOriginAccess,
} from "./lib/permissions";
import {
    addPairedOrigin,
    getPairedOrigins,
    removePairedOrigin,
    type StoredOrigin,
} from "./lib/storage";

const HARD_CODED_ORIGINS = ["https://riffado.com"]; // already in manifest host_permissions

function normalize(input: string): string | null {
    try {
        const u = new URL(input);
        if (u.protocol !== "https:" && u.protocol !== "http:") return null;
        // Drop path/query — we only need origin granularity.
        return `${u.protocol}//${u.host}`;
    } catch {
        return null;
    }
}

async function render(origins: StoredOrigin[]): Promise<void> {
    const list = document.getElementById("origins-list") as HTMLUListElement;
    const access = await Promise.all(
        origins.map((o) =>
            HARD_CODED_ORIGINS.includes(o.origin)
                ? Promise.resolve(true)
                : hasOriginAccess(o.origin),
        ),
    );
    list.innerHTML = "";

    if (origins.length === 0) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "No self-hosted instances paired.";
        list.appendChild(li);
        return;
    }

    origins.forEach((o, i) => {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.className = "origin";
        span.textContent = o.origin;
        li.appendChild(span);

        if (!access[i]) {
            const grant = document.createElement("button");
            grant.className = "grant";
            grant.type = "button";
            grant.textContent = "Grant access";
            grant.title = "Firefox has no permission for this origin";
            grant.addEventListener("click", () => {
                // Must run before any await (Firefox user-action rule).
                const req = requestOriginAccess(o.origin);
                void req.then(async () => render(await getPairedOrigins()));
            });
            li.appendChild(grant);
        }

        const btn = document.createElement("button");
        btn.className = "remove";
        btn.type = "button";
        btn.textContent = "Remove";
        btn.addEventListener("click", async () => {
            await revokeOriginAccess(o.origin);
            const next = await removePairedOrigin(o.origin);
            await render(next);
        });
        li.appendChild(btn);
        list.appendChild(li);
    });
}

async function renderHostAccessBanner(): Promise<void> {
    const banner = document.getElementById("host-access") as HTMLElement | null;
    if (!banner) return;
    banner.hidden = await hasRequiredHostAccess();
}

async function init(): Promise<void> {
    const openHosted = document.getElementById(
        "open-hosted",
    ) as HTMLButtonElement | null;
    openHosted?.addEventListener("click", () => {
        chrome.tabs.create({ url: "https://riffado.com" }).catch(() => {
            window.open("https://riffado.com", "_blank", "noopener");
        });
    });

    const openWelcome = document.getElementById(
        "open-welcome",
    ) as HTMLAnchorElement | null;
    openWelcome?.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({
            url: chrome.runtime.getURL("src/welcome.html"),
        });
    });

    const grantHost = document.getElementById(
        "grant-host-access",
    ) as HTMLButtonElement | null;
    grantHost?.addEventListener("click", () => {
        // Must run before any await (Firefox user-action rule).
        void requestHostAccess().then(() => renderHostAccessBanner());
    });

    const form = document.getElementById("add-form") as HTMLFormElement;
    const input = document.getElementById("origin-input") as HTMLInputElement;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const origin = normalize(input.value.trim());
        if (!origin) {
            input.setCustomValidity(
                "Enter a full URL like https://my.example.com",
            );
            input.reportValidity();
            return;
        }
        input.setCustomValidity("");

        if (HARD_CODED_ORIGINS.includes(origin)) {
            // Already covered by the manifest; just persist for visibility.
            const next = await addPairedOrigin(origin);
            await render(next);
            input.value = "";
            return;
        }

        // Start the request synchronously (Firefox user-action rule), then
        // store the origin while the prompt is open, in case the prompt
        // closes this popup.
        const request = requestOriginAccess(origin);
        await addPairedOrigin(origin);
        const granted = await request;
        if (!granted) {
            await render(await removePairedOrigin(origin));
            input.setCustomValidity(
                "Permission denied. The connector needs access to the Riffado origin to deliver the token.",
            );
            input.reportValidity();
            return;
        }
        await render(await getPairedOrigins());
        input.value = "";
    });

    await Promise.all([
        render(await getPairedOrigins()),
        renderHostAccessBanner(),
    ]);
}

void init();
