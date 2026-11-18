/**
 * Welcome page entrypoint.
 *
 * Shown once on first install (see chrome.runtime.onInstalled in
 * background.ts). Walks a non-technical user through the three steps to
 * actually use the extension and lets self-hosters pair their instance
 * without ever opening the popup.
 *
 * The self-hosted pairing flow is the same as in popup.ts \u2014 we duplicate
 * a small amount of code here on purpose so the welcome page is a single
 * focused entrypoint and so popup.ts stays unchanged in behavior.
 */

import {
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

const HARD_CODED_ORIGINS = ["https://riffado.com"];

function normalize(input: string): string | null {
    try {
        const u = new URL(input);
        if (u.protocol !== "https:" && u.protocol !== "http:") return null;
        return `${u.protocol}//${u.host}`;
    } catch {
        return null;
    }
}

async function renderHostAccessBanner(): Promise<void> {
    const banner = document.getElementById("host-access") as HTMLElement | null;
    if (!banner) return;
    banner.hidden = await hasRequiredHostAccess();
}

function setStatus(message: string, kind: "ok" | "error" | "" = ""): void {
    const el = document.getElementById("add-status") as HTMLParagraphElement;
    el.textContent = message;
    el.classList.remove("ok", "error");
    if (kind) el.classList.add(kind);
}

function render(origins: StoredOrigin[]): void {
    const list = document.getElementById("origins-list") as HTMLUListElement;
    list.innerHTML = "";

    if (origins.length === 0) return;

    for (const o of origins) {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.className = "origin";
        span.textContent = o.origin;
        li.appendChild(span);

        const btn = document.createElement("button");
        btn.className = "remove";
        btn.type = "button";
        btn.textContent = "Remove";
        btn.addEventListener("click", async () => {
            await revokeOriginAccess(o.origin);
            const next = await removePairedOrigin(o.origin);
            render(next);
        });
        li.appendChild(btn);
        list.appendChild(li);
    }
}

async function init(): Promise<void> {
    const openHosted = document.getElementById(
        "open-hosted",
    ) as HTMLButtonElement;
    openHosted.addEventListener("click", () => {
        chrome.tabs.create({ url: "https://riffado.com" }).catch(() => {
            // Fallback in case tabs.create is somehow unavailable.
            window.open("https://riffado.com", "_blank", "noopener");
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
        setStatus("");
        const origin = normalize(input.value.trim());
        if (!origin) {
            setStatus(
                "Enter a full URL like https://my-riffado.example.com",
                "error",
            );
            return;
        }

        if (HARD_CODED_ORIGINS.includes(origin)) {
            const next = await addPairedOrigin(origin);
            render(next);
            input.value = "";
            setStatus("Added.", "ok");
            return;
        }

        // Start the request synchronously: Firefox rejects
        // permissions.request() after an await (user-action rule).
        const granted = await requestOriginAccess(origin);
        if (!granted) {
            setStatus(
                "Permission denied. The connector needs access to your Riffado origin to deliver the token.",
                "error",
            );
            return;
        }
        const next = await addPairedOrigin(origin);
        render(next);
        input.value = "";
        setStatus("Added. You can now use Continue with Plaud there.", "ok");
    });

    render(await getPairedOrigins());
    await renderHostAccessBanner();
}

void init();
