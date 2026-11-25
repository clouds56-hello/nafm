import { useLayoutEffect, useRef, useState } from "react";

export function useAnalysisNavigation<Match>(
  onJump: (match: Match, signal: AbortSignal) => Promise<string | null>,
  onClose: () => void,
  onOpened: (match: Match) => void = onClose,
  revision?: number,
) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    setOpening(false);
    setError(null);
    return () => {
      attempt.current?.abort();
      attempt.current = null;
    };
  }, [revision]);

  function close() {
    attempt.current?.abort();
    onClose();
  }

  async function show(match: Match) {
    if (attempt.current) return;
    const request = new AbortController();
    attempt.current = request;
    setOpening(true);
    setError(null);
    try {
      const failure = await onJump(match, request.signal);
      if (request.signal.aborted) return;
      if (failure === null) onOpened(match);
      else setError(failure);
    } finally {
      if (attempt.current === request) {
        attempt.current = null;
        setOpening(false);
      }
    }
  }

  return { opening, error, close, show, clearError: () => setError(null) };
}
