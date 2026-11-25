import { useLayoutEffect, useRef, useState } from "react";
import { getAdjacentStorageFile } from "../lib/tauri";
import type { DirectoryAdjacentFile, DirectoryAdjacentFileRequest, DirectoryFileDirection, StorageChildrenPage } from "../lib/types";

interface FileStepContext {
  owner: object;
  request: Omit<DirectoryAdjacentFileRequest, "direction">;
  revision: number;
}

interface FileStepState {
  owner: object;
  key: string;
  boundaries: Partial<Record<DirectoryFileDirection, true>>;
  pending: DirectoryFileDirection | null;
  status: string;
}

function adjacentInPage(
  page: StorageChildrenPage | null, childId: string, direction: DirectoryFileDirection,
): DirectoryAdjacentFile | null | undefined {
  if (!page) return undefined;
  const start = page.children.findIndex((child) => child.id === childId);
  if (start < 0) return undefined;
  const increment = direction === "next" ? 1 : -1;
  for (let offset = start + increment; offset >= 0 && offset < page.children.length; offset += increment) {
    if (page.children[offset].kind === "file") return { index: page.offset + offset, page };
  }
  const atBoundary = direction === "next" ? page.offset + page.children.length >= page.total_children : page.offset === 0;
  return atBoundary ? null : undefined;
}

export function useContentsFileStep(
  context: FileStepContext | null,
  page: StorageChildrenPage | null,
  blocked: boolean,
  onFound: (result: DirectoryAdjacentFile) => void,
) {
  const [state, setState] = useState<FileStepState | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const owner = context?.owner;
  const key = context ? JSON.stringify([context.request, context.revision]) : null;
  useLayoutEffect(() => {
    setState(null);
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [blocked, key, owner]);

  if (!context || !key) return undefined;
  const saved = state?.owner === context.owner && state.key === key && !blocked ? state : null;
  const candidates = {
    previous: adjacentInPage(page, context.request.child_id, "previous"),
    next: adjacentInPage(page, context.request.child_id, "next"),
  };
  const canStep = (direction: DirectoryFileDirection) =>
    !blocked && candidates[direction] !== null && !saved?.boundaries[direction];

  async function step(direction: DirectoryFileDirection) {
    if (!context || !key || !canStep(direction) || inFlight.current) return;
    const candidate = candidates[direction];
    if (candidate) {
      setState(null);
      onFound(candidate);
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    const scoped = { owner: context.owner, key, boundaries: saved?.boundaries ?? {} };
    setState({ ...scoped, pending: direction, status: `Finding the ${direction} file…` });
    try {
      const result = await getAdjacentStorageFile({ ...context.request, direction }, 64);
      if (controller.signal.aborted) return;
      if (result) {
        setState(null);
        onFound(result);
      } else {
        setState({
          ...scoped, boundaries: { ...scoped.boundaries, [direction]: true },
          pending: null, status: `No ${direction} file in this list.`,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        setState({ ...scoped, pending: null, status: `Couldn’t find the ${direction} file. ${detail}` });
      }
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  return {
    previous: canStep("previous"),
    next: canStep("next"),
    pending: saved?.pending ?? null,
    status: saved?.status ?? "",
    onStep: (direction: DirectoryFileDirection) => void step(direction),
  };
}
