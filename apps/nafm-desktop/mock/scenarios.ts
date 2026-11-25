import type { PreviewScenario } from "./fixtures";

export const scenarioLabels = {
  populated: "Indexed workspace",
  deep: "Deep folder hierarchy",
  partial: "Partial verification",
  empty: "Empty workspace",
  scanning: "Scan in progress",
  slow: "Slow folder reads",
  recovery: "Interrupted navigation",
} satisfies Record<PreviewScenario, string>;

export function getScenario(url: URL): PreviewScenario {
  const value = url.searchParams.get("scenario");
  return value && Object.hasOwn(scenarioLabels, value) ? value as PreviewScenario : "populated";
}
