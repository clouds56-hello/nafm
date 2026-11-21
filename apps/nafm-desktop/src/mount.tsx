import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

export function mountApp(root: HTMLElement, toolbarExtension?: ReactNode) {
  createRoot(root).render(
    <StrictMode>
      <App toolbarExtension={toolbarExtension} />
    </StrictMode>,
  );
}
