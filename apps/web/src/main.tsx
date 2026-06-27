import { StrictMode } from "react";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { dAppKit } from "./dapp-kit.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <DAppKitProvider dAppKit={dAppKit}>
      <App />
    </DAppKitProvider>
  </StrictMode>,
);
