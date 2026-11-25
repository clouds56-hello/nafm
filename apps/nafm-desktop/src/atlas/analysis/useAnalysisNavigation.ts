import { useEffect, useRef, useState } from "react";

export function useAnalysisNavigation<Match>(
  onJump: (match: Match, signal: AbortSignal) => Promise<string | null>,
  onClose: () => void,
) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);

  useEffect(() => () => attempt.current?.abort(), []);

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
      if (failure === null) onClose();
      else setError(failure);
    } finally {
      attempt.current = null;
      if (!request.signal.aborted) setOpening(false);
    }
  }

  return { opening, error, close, show, clearError: () => setError(null) };
}
