import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import "@executor/react/globals.css";

const router = getRouter();

ReactDOM.createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
