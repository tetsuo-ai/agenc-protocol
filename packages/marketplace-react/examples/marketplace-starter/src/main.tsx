import React from "react";
import { createRoot } from "react-dom/client";
import "@tetsuo-ai/marketplace-react/theme.css";
import "@tetsuo-ai/marketplace-react/components.css";
import "./styles.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
