import { installPreviewBackend } from "./backend";
import { getScenario } from "./scenarios";

installPreviewBackend(getScenario(new URL(window.location.href)));
void import("../src/main");
