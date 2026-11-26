import { useLayoutEffect, useRef, useState } from "react";

export function useAnalysisNavigation<Match>(
  onJump: (match: Match, signal: AbortSignal) => Promise<string | null>,
  onClose: () => void,
  onOpened: (match: Match) => void = onClose,
) {
  const [current, setCurrent] = useState<{ match: Match; error: string | null } | null>(null);
  const attempt = useRef<AbortController | null>(null);

  useLayoutEffect(() => () => {
    attempt.current?.abort();
    attempt.current = null;
  }, []);

  function cancel() {
    const request = attempt.current;
    if (!request) return;
    attempt.current = null;
    request.abort();
    setCurrent(null);
  }

  function close() {
    cancel();
    onClose();
  }

  async function show(match: Match) {
    if (attempt.current) return;
    const request = new AbortController();
    attempt.current = request;
    setCurrent({ match, error: null });
    try {
      const failure = await onJump(match, request.signal);
      if (request.signal.aborted) return;
      if (failure === null) onOpened(match);
      else setCurrent({ match, error: failure });
    } finally {
      if (attempt.current === request) {
        attempt.current = null;
        setCurrent((previous) => previous?.error === null ? null : previous);
      }
    }
  }

  return {
    opening: current !== null && current.error === null,
    error: current?.error ?? null,
    match: current?.match ?? null,
    close, show, cancel,
    retry: () => { if (current?.error != null) void show(current.match); },
    clearError: () => setCurrent((previous) => previous?.error != null ? null : previous),
  };
}
