import { DEFAULT_DIRECTORY_SORT, type DirectorySort } from "./types";

const unsavedSorts = new Map<string, DirectorySort>();

function preferenceKey(workspaceName: string, siteId: string) {
  return "nafm.directory-sort:" + JSON.stringify([workspaceName, siteId]);
}

export function readSiteDirectorySort(workspaceName: string | null, siteId: string): DirectorySort {
  if (!workspaceName) return DEFAULT_DIRECTORY_SORT;
  const key = preferenceKey(workspaceName, siteId);
  const unsaved = unsavedSorts.get(key);
  if (unsaved) return unsaved;

  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return DEFAULT_DIRECTORY_SORT;
    const saved: Partial<DirectorySort> | null = JSON.parse(raw);
    if (saved && (saved.field === "size" || saved.field === "name" || saved.field === "date")
      && (saved.direction === "asc" || saved.direction === "desc")) {
      return { field: saved.field, direction: saved.direction };
    }
  } catch {
    // An unreadable preference should still allow the site to open.
  }
  return DEFAULT_DIRECTORY_SORT;
}

export function writeSiteDirectorySort(workspaceName: string, siteId: string, sort: DirectorySort) {
  const key = preferenceKey(workspaceName, siteId);
  try {
    localStorage.setItem(key, JSON.stringify(sort));
    unsavedSorts.delete(key);
  } catch {
    // Keep this session's choice when the webview cannot write to its storage.
    unsavedSorts.set(key, sort);
  }
}
