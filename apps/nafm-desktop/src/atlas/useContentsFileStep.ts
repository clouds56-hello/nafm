import { useLayoutEffect, useRef, useState } from "react";
import { getAdjacentStorageFile } from "../lib/tauri";
import type { DirectoryAdjacentFile, DirectoryAdjacentFileRequest, DirectoryFileDirection, StorageChildrenPage } from "../lib/types";

interface FileStepContext {
  owner: object;
  request: Omit<DirectoryAdjacentFileRequest, "direction">;
  revision: number;
}

interface FileStepScope {
  owner: object;
  key: string;
}

interface PendingFileStep extends FileStepScope {
  request: DirectoryAdjacentFileRequest;
}

interface FileStepFeedback extends FileStepScope {
  revision: number;
  boundaries: Partial<Record<DirectoryFileDirection, true>>;
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
  const [pending, setPending] = useState<PendingFileStep | null>(null);
  const [feedback, setFeedback] = useState<FileStepFeedback | null>(null);
  const publishResult = useRef(onFound);
  const owner = context?.owner;
  const key = context ? JSON.stringify(context.request) : null;
  const revision = context?.revision;
  const activeStep = !blocked && pending && pending.owner === owner && pending.key === key ? pending : null;

  useLayoutEffect(() => {
    publishResult.current = onFound;
  }, [onFound]);

  useLayoutEffect(() => {
    setFeedback(null);
  }, [blocked, key, owner, revision]);

  useLayoutEffect(() => {
    if (!activeStep || revision === undefined) {
      if (pending) setPending(null);
      return;
    }
    // Re-read on the latest inventory while the original file review still owns the step.
    const { owner, key, request } = activeStep;
    const direction = request.direction;
    const controller = new AbortController();

    const report = (status: string, atBoundary = false) => {
      setFeedback((previous) => {
        const boundaries = previous?.owner === owner && previous.key === key && previous.revision === revision
          ? previous.boundaries : {};
        return {
          owner, key, revision,
          status, boundaries: atBoundary ? { ...boundaries, [direction]: true } : boundaries,
        };
      });
    };

    async function read() {
      try {
        const result = await getAdjacentStorageFile(request, 64);
        if (controller.signal.aborted) return;
        if (result) {
          publishResult.current(result);
          setFeedback(null);
        } else {
          report(`No ${direction} file in this list.`, true);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail = error instanceof Error ? error.message : String(error);
        report(`Couldn’t find the ${direction} file. ${detail}`);
      } finally {
        if (!controller.signal.aborted) setPending(null);
      }
    }

    void read();
    return () => controller.abort();
  }, [activeStep, pending, revision]);

  if (!context || !key) return undefined;
  const saved = !blocked && feedback && feedback.owner === owner && feedback.key === key && feedback.revision === revision
    ? feedback : null;
  const candidates = {
    previous: adjacentInPage(page, context.request.child_id, "previous"),
    next: adjacentInPage(page, context.request.child_id, "next"),
  };
  const canStep = (direction: DirectoryFileDirection) =>
    !blocked && candidates[direction] !== null && !saved?.boundaries[direction];

  function step(direction: DirectoryFileDirection) {
    if (!context || !key || !canStep(direction) || activeStep) return;
    const candidate = candidates[direction];
    if (candidate) {
      setFeedback(null);
      onFound(candidate);
      return;
    }
    setPending((scheduled) => scheduled ?? { owner: context.owner, key, request: { ...context.request, direction } });
  }

  const pendingDirection = activeStep?.request.direction ?? null;
  return {
    previous: canStep("previous"),
    next: canStep("next"),
    pending: pendingDirection,
    status: pendingDirection ? `Finding the ${pendingDirection} file…` : saved?.status ?? "",
    onStep: step,
  };
}
