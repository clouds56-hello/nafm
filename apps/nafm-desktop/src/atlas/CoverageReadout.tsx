import { formatCount } from "../lib/format";
import { formatHealthScore, healthAriaDescription, isPerfectHealth, type HealthPresentation } from "../lib/health";
import type { StorageNode } from "../lib/types";
import { CheckIcon } from "../management/Icons";
import type { SiteVerification } from "./siteVerification";
import "./coverage-readout.css";

export interface CoverageSummary {
  score: HealthPresentation | null;
  evidence: string | null;
}

export function coverageSummary(
  folder: StorageNode, score: HealthPresentation | null, source: SiteVerification, target: SiteVerification | null,
): CoverageSummary {
  if (!target) return { score: null, evidence: null };
  if (folder.file_count > 0 && score && score.value !== null) {
    const total = folder.coverage_total_files;
    const count = formatCount(folder.coverage_covered_files);
    const groups = total === 1 ? "group" : "groups";
    const description = score.state === "partial" ? `verified ${groups} found` : `content ${groups} covered`;
    return {
      score,
      evidence: total > 0 ? `${count} of ${formatCount(total)} ${description}` : null,
    };
  }

  let evidence: string | null = null;
  if (!folder.file_count && source.tone === "ready") evidence = "No content in this folder to compare.";
  else if (source.needsVerification && target.needsVerification) evidence = "Both sites need verification.";
  else if (source.needsVerification) evidence = "Source verification is pending.";
  else if (target.needsVerification) evidence = "Target verification is pending.";
  else if (folder.file_count) evidence = "Verified inventories can’t be compared.";
  return { score: null, evidence };
}

export function CoverageReadout({ summary, progress, announce, id }: {
  summary: CoverageSummary | null;
  progress?: string;
  announce?: boolean;
  id?: string;
}) {
  const score = summary?.score;
  return (
    <div id={id} className="atlas-coverage-status" role={announce ? "status" : undefined}>
      {progress ? <span data-tone="active">{progress}</span> : (
        <>
          {score ? (
            <span className="atlas-coverage-score" data-tone={score.state === "partial" ? "estimate" : undefined}>
              <span className="atlas-coverage-score-value" aria-hidden="true">{formatHealthScore(score)}/100</span>
              <span className="atlas-coverage-score-description">{healthAriaDescription(score, "coverage")}</span>
              {isPerfectHealth(score) && <CheckIcon className="atlas-score-check" role="img" aria-hidden={false} aria-label="Perfect score" />}
            </span>
          ) : <span>Coverage unavailable</span>}
          {summary?.evidence && <span>{summary.evidence}</span>}
        </>
      )}
    </div>
  );
}
