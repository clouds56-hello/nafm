import { useCallback, useRef, useState } from "react";
import { openFolderIn } from "../lib/tauri";
import type { FolderOpenRequest } from "../lib/types";

export function folderLaunchKey(workspace: string, site: string, node: string) {
  return JSON.stringify([workspace, site, node]);
}

export function useFolderLaunches() {
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const run = useCallback((request: FolderOpenRequest) => {
    const key = folderLaunchKey(request.workspace_name, request.site_id, request.node_id);
    if (inFlight.current.has(key)) return null;
    inFlight.current.add(key);
    setPending(new Set(inFlight.current));
    return Promise.resolve().then(() => openFolderIn(request)).finally(() => {
      inFlight.current.delete(key);
      setPending(new Set(inFlight.current));
    });
  }, []);

  return { pending, run };
}

export type FolderLaunches = ReturnType<typeof useFolderLaunches>;
