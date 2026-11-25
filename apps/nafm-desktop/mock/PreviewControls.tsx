import { ToolbarDisclosure } from "../src/atlas/ToolbarDisclosure";
import type { PreviewScenario } from "./fixtures";
import { scenarioLabels } from "./scenarios";
import "./preview-controls.css";

export function PreviewControls({ url, scenario }: { url: URL; scenario: PreviewScenario }) {
  const appOnlyUrl = new URL("./atlas.html", url);
  appOnlyUrl.searchParams.set("scenario", scenario);

  function chooseScenario(value: string) {
    const next = new URL(url);
    next.searchParams.set("scenario", value);
    window.location.assign(next.href);
  }

  function resetScenario() {
    const next = new URL(url);
    next.searchParams.set("reset", "1");
    window.location.replace(next.href);
  }

  return (
    <ToolbarDisclosure
      label="Preview"
      summary="Preview"
      icon={
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
          <path d="M6.5 13.5h3M6 5.25l3.5 1.75L6 8.75z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      }
    >
      {(close) => (
        <div className="atlas-preview-controls">
          <p>Sample data</p>
          <label>
            Scenario
            <select value={scenario} onChange={(event) => chooseScenario(event.currentTarget.value)}>
              {Object.entries(scenarioLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <div className="atlas-preview-actions">
            <button type="button" onClick={resetScenario}>Reset</button>
            <a href={appOnlyUrl.href} target="_blank" rel="noopener" onClick={close}>
              App only <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      )}
    </ToolbarDisclosure>
  );
}
