/**
 * Host-permission helpers shared by the popup and the welcome page.
 *
 * Firefox shows the manifest `host_permissions` at install time, but the user
 * can revoke them later in about:addons ("Permissions" tab). Without the
 * plaud.ai hosts the background cannot read the `pld_ut` cookie or verify the
 * token, so the connect flow would silently time out. These helpers let the UI
 * detect that state and ask again.
 *
 * Firefox only accepts `permissions.request()` while it is handling a user
 * action. Call `requestHostAccess()` / `requestOriginAccess()` synchronously
 * from the click/submit handler, before any `await`, or Firefox rejects it.
 */

export function requiredOrigins(): string[] {
    return chrome.runtime.getManifest().host_permissions ?? [];
}

export async function hasRequiredHostAccess(): Promise<boolean> {
    try {
        return await chrome.permissions.contains({ origins: requiredOrigins() });
    } catch {
        return false;
    }
}

export function requestHostAccess(): Promise<boolean> {
    return chrome.permissions
        .request({ origins: requiredOrigins() })
        .catch(() => false);
}

export function originPattern(origin: string): string {
    return `${origin}/*`;
}

export function requestOriginAccess(origin: string): Promise<boolean> {
    // Rejects if the origin isn't covered by optional_host_permissions, or if
    // the call was not made from a user action.
    return chrome.permissions
        .request({ origins: [originPattern(origin)] })
        .catch(() => false);
}

export async function hasOriginAccess(origin: string): Promise<boolean> {
    try {
        return await chrome.permissions.contains({
            origins: [originPattern(origin)],
        });
    } catch {
        return false;
    }
}

export async function revokeOriginAccess(origin: string): Promise<void> {
    try {
        await chrome.permissions.remove({ origins: [originPattern(origin)] });
    } catch {
        // Permission may already be gone; ignore.
    }
}
