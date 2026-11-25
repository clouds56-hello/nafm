import type { PreviewScenario } from "./fixtures";

export const scenarioLabels = {
  populated: "Indexed workspace",
  large: "Large folder",
  deep: "Deep folder hierarchy",
  partial: "Partial verification",
  empty: "Empty workspace",
  "first-inventory": "First scan, slow map",
  scanning: "Scan in progress",
  "scan-failed": "Interrupted scan",
  slow: "Slow folder reads",
  recovery: "Interrupted navigation",
  "workspace-recovery": "Workspace switch recovery",
} satisfies Record<PreviewScenario, string>;

export function getScenario(url: URL): PreviewScenario {
  const value = url.searchParams.get("scenario");
  return value && Object.hasOwn(scenarioLabels, value) ? value as PreviewScenario : "populated";
}
