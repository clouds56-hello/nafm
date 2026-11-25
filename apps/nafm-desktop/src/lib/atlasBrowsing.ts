interface SiteFolder {
  site_id: string;
  node_id: string;
}

interface AtlasBrowsing {
  active_site_id: string | null;
  site_folders: SiteFolder[];
}

function scopePrefix(scope: string) {
  return `nafm.atlas-location:${encodeURIComponent(scope)}:`;
}

function preferenceKey(scope: string, workspace: string) {
  return scopePrefix(scope) + encodeURIComponent(workspace);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSiteFolder(value: unknown): value is SiteFolder {
  return typeof value === "object" && value !== null
    && "site_id" in value && nonemptyString(value.site_id)
    && "node_id" in value && nonemptyString(value.node_id);
}

export function readAtlasBrowsing(scope: string, workspace: string): AtlasBrowsing {
  const initial: AtlasBrowsing = { active_site_id: null, site_folders: [] };
  try {
    const raw = localStorage.getItem(preferenceKey(scope, workspace));
    if (raw === null) return initial;
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== "object" || saved === null) return initial;

    const activeSite = "active_site_id" in saved && nonemptyString(saved.active_site_id) ? saved.active_site_id : null;
    const folders = new Map<string, SiteFolder>();
    if ("site_folders" in saved && Array.isArray(saved.site_folders)) {
      for (const folder of saved.site_folders) {
        if (isSiteFolder(folder)) folders.set(folder.site_id, { site_id: folder.site_id, node_id: folder.node_id });
      }
    }
    return { active_site_id: activeSite, site_folders: [...folders.values()] };
  } catch {
    return initial;
  }
}

export function rememberAtlasFolder(
  scope: string, workspace: string, siteId: string, nodeId: string, validSiteIds: ReadonlySet<string>,
) {
  if (!validSiteIds.has(siteId)) return;
  const previous = readAtlasBrowsing(scope, workspace);
  const siteFolders = previous.site_folders.filter((folder) => validSiteIds.has(folder.site_id));
  if (previous.active_site_id === siteId && siteFolders.length === previous.site_folders.length
    && siteFolders.some((folder) => folder.site_id === siteId && folder.node_id === nodeId)) return;

  const next: AtlasBrowsing = {
    active_site_id: siteId,
    site_folders: [...siteFolders.filter((folder) => folder.site_id !== siteId), { site_id: siteId, node_id: nodeId }],
  };
  try {
    localStorage.setItem(preferenceKey(scope, workspace), JSON.stringify(next));
  } catch {
    // Browsing still works when the webview cannot save preferences.
  }
}

export function clearAtlasBrowsingScope(scope: string) {
  try {
    const prefix = scopePrefix(scope);
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Reset can still reload the mock when local storage is unavailable.
  }
}
