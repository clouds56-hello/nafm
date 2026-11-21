import { getScenario, scenarioLabels } from "./scenarios";

const scenario = document.querySelector<HTMLSelectElement>("#scenario")!;
let preview = document.querySelector<HTMLIFrameElement>("#preview")!;
const openAtlas = document.querySelector<HTMLAnchorElement>("#open-atlas")!;
const reset = document.querySelector<HTMLButtonElement>("#reset")!;

for (const [value, label] of Object.entries(scenarioLabels)) {
  scenario.add(new Option(label, value));
}

function loadPreview() {
  scenario.value = getScenario(new URL(window.location.href));
  const atlasUrl = new URL("./atlas.html", window.location.href);
  atlasUrl.searchParams.set("scenario", scenario.value);
  openAtlas.href = atlasUrl.href;
  const frame = preview.cloneNode() as HTMLIFrameElement;
  frame.src = atlasUrl.href;
  preview.replaceWith(frame);
  preview = frame;
}

scenario.addEventListener("change", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("scenario", scenario.value);
  window.history.pushState(null, "", url);
  loadPreview();
});

reset.addEventListener("click", loadPreview);
window.addEventListener("popstate", loadPreview);
loadPreview();
