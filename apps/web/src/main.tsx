import React from "react";
import { createRoot } from "react-dom/client";
import "@executor/ui/globals.css";
import { App } from "./App";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
