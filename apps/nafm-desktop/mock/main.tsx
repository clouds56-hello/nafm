import { mountApp } from "../src/mount";
import { clearAtlasBrowsingScope } from "../src/lib/atlasBrowsing";
import { installPreviewBackend } from "./backend";
import { PreviewControls } from "./PreviewControls";
import { getScenario } from "./scenarios";

const root = document.getElementById("root")!;
const url = new URL(window.location.href);
const scenario = getScenario(url);
const browsingScope = `preview:${scenario}`;

// Clear in the new document so an in-flight read from the outgoing mock can't undo Reset.
if (url.searchParams.get("reset") === "1") {
  clearAtlasBrowsingScope(browsingScope);
  url.searchParams.delete("reset");
  window.history.replaceState(window.history.state, "", url.href);
}

installPreviewBackend(scenario);
mountApp(root, {
  browsingScope,
  toolbarExtension: root.hasAttribute("data-preview-controls")
    ? <PreviewControls url={url} scenario={scenario} /> : undefined,
});
