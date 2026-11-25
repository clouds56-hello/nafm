import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { type AppProps } from "./App";

export function mountApp(root: HTMLElement, props: AppProps = {}) {
  createRoot(root).render(
    <StrictMode>
      <App {...props} />
    </StrictMode>,
  );
}
