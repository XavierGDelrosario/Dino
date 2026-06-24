import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LocaleProvider } from "./i18n";
import { RouterProvider } from "./router";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <RouterProvider>
        <App />
      </RouterProvider>
    </LocaleProvider>
  </StrictMode>
);
