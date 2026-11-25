import type { ReactNode } from "react";
import { OpenInIcon } from "../../management/Icons";
import "./analysis-comparison.css";

interface AnalysisLocationProps {
  label: string;
  name: string;
  site: string;
  path?: string | null;
  detail?: ReactNode;
  children?: ReactNode;
}

export function AnalysisLocation({ label, name, site, path, detail, children }: AnalysisLocationProps) {
  return (
    <section className="atlas-analysis-entity" aria-label={label}>
      <p>{label}</p>
      <h3>{name}</h3>
      <div className="atlas-analysis-entity-meta">
        <span>{site}</span>
        {detail != null && <span>{detail}</span>}
      </div>
      {path && <code>{path}</code>}
      {children}
    </section>
  );
}

interface AnalysisNavigationFooterProps {
  error: string | null;
  opening: boolean;
  disabled: boolean;
  pendingLabel: string;
  onShow: () => void;
}

export function AnalysisNavigationFooter({ error, opening, disabled, pendingLabel, onShow }: AnalysisNavigationFooterProps) {
  return (
    <>
      {error && <p className="atlas-analysis-reveal-error" role="alert">{error}</p>}
      <button
        className="atlas-analysis-primary atlas-analysis-reveal-button" type="button"
        aria-disabled={disabled || opening || undefined} aria-busy={opening || undefined}
        onClick={disabled || opening ? undefined : onShow}
      >
        {opening ? pendingLabel : "Show in Atlas"} <OpenInIcon />
      </button>
    </>
  );
}
