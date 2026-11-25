import { useLayoutEffect, useRef, useState } from "react";
import { searchIndexedFiles } from "../lib/tauri";
import type { DirectoryFileDirection, FinderPosition, IndexedFileSearchResult } from "../lib/types";
import { FINDER_PAGE_SIZE } from "./useIndexedFileSearch";

type FinderRank = Pick<FinderPosition, "row_index" | "result_count">;

interface FinderStep {
  source: FinderPosition;
  direction: DirectoryFileDirection;
}

interface FinderStepFeedback {
  source: FinderPosition;
  revision: number;
  rank?: FinderRank | null;
  status: string;
}

export function useFinderFileStep(
  workspace: string | null,
  position: FinderPosition | null,
  revision: number,
  blocked: boolean,
  open: (file: IndexedFileSearchResult, signal: AbortSignal, position: FinderPosition) => Promise<string | null>,
  onOpened: (position: FinderPosition) => void,
) {
  const [requested, setRequested] = useState<FinderStep | null>(null);
  const [feedback, setFeedback] = useState<FinderStepFeedback | null>(null);
  const callbacks = useRef({ open, onOpened });
  const activeRequest = useRef<AbortController>(null);
  const pending = workspace && requested?.source === position ? requested : null;
  const saved = feedback?.source === position && feedback.revision === revision ? feedback : null;
  const rank = saved?.rank === undefined ? (position?.content_revision === revision ? position : null) : saved.rank;

  useLayoutEffect(() => {
    callbacks.current = { open, onOpened };
  }, [open, onOpened]);

  useLayoutEffect(() => {
    if (!workspace || !pending) {
      if (requested) setRequested(null);
      return;
    }
    const { source, direction } = pending;
    const controller = new AbortController();
    activeRequest.current = controller;
    const report = (status: string, rank?: FinderRank | null) => setFeedback({ source, revision, status, rank });

    const step = async () => {
      try {
        const page = await searchIndexedFiles(workspace, source.query.trim(), source.row_index, FINDER_PAGE_SIZE, source.file_id, direction);
        if (controller.signal.aborted) return;
        const { anchor_index, neighbor_index, total_matches } = page;
        if (anchor_index === undefined) {
          report("This file is no longer in these results.", null);
          return;
        }
        const anchorRank = { row_index: anchor_index, result_count: total_matches };
        const index = anchor_index + (direction === "next" ? 1 : -1);
        if (index < 0 || index >= total_matches) {
          report(direction === "next" ? "This is the last result." : "This is the first result.", anchorRank);
          return;
        }
        const file = neighbor_index === index ? page.matches[index - page.offset] : undefined;
        if (!file || file.file_id === source.file_id) throw new Error("The search returned an unexpected result.");
        const next: FinderPosition = {
          ...source,
          content_revision: revision,
          file_id: file.file_id,
          row_index: index,
          scroll_position: source.scroll_position === "end"
            ? source.scroll_position : Math.max(0, source.scroll_position + index - source.row_index),
          result_count: total_matches,
        };
        const failure = await callbacks.current.open(file, controller.signal, next);
        if (failure === null) callbacks.current.onOpened(next);
        else if (!controller.signal.aborted) report(failure, anchorRank);
      } catch (error) {
        if (!controller.signal.aborted) {
          const detail = error instanceof Error ? error.message : String(error);
          report(`Couldn’t open the ${direction} result. ${detail}`);
        }
      } finally {
        if (!controller.signal.aborted) setRequested(null);
      }
    };

    void step();
    return () => {
      if (activeRequest.current === controller) activeRequest.current = null;
      controller.abort();
    };
  }, [pending, requested, revision, workspace]);

  if (!workspace || !position) return undefined;
  const previous = !blocked && saved?.rank !== null && (!rank || rank.row_index > 0);
  const next = !blocked && saved?.rank !== null && (!rank || rank.row_index + 1 < rank.result_count);
  return {
    previous,
    next,
    pending: pending?.direction ?? null,
    status: pending ? `Opening the ${pending.direction} result…` : saved?.status ?? "",
    rank,
    cancel: () => {
      activeRequest.current?.abort();
      setRequested(null);
    },
    onStep: (direction: DirectoryFileDirection) => {
      if (!pending && (direction === "next" ? next : previous)) {
        setRequested((active) => active?.source === position ? active : { source: position, direction });
      }
    },
  };
}
