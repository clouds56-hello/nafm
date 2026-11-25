import { useState } from "react";

export function useAnalysisSelection<Match>(
  matches: readonly Match[], identify: (match: Match) => string, pageSequence: number, ready: boolean, initialMatch?: Match,
) {
  const [selection, setSelection] = useState({ pageSequence, match: initialMatch });
  const previous = selection.pageSequence === pageSequence ? selection.match : undefined;
  const selected = previous === undefined
    ? matches[0]
    : matches.find((match) => identify(match) === identify(previous));

  // Remember the comparison displayed on this page, including its initial default.
  if (ready && (selection.pageSequence !== pageSequence || (selected !== undefined && selected !== previous))) {
    setSelection({ pageSequence, match: selected });
  }

  return {
    selected,
    unavailable: selected === undefined ? previous : undefined,
    choose: (match: Match) => setSelection({ pageSequence, match }),
  };
}
