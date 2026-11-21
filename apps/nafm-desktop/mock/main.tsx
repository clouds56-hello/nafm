import { mountApp } from "../src/mount";
import { installPreviewBackend } from "./backend";
import { PreviewControls } from "./PreviewControls";
import { getScenario } from "./scenarios";

const root = document.getElementById("root")!;
const url = new URL(window.location.href);
const scenario = getScenario(url);

installPreviewBackend(scenario);
mountApp(root, root.hasAttribute("data-preview-controls") ? <PreviewControls url={url} scenario={scenario} /> : undefined);
