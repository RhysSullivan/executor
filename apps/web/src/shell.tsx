import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui" }}>
      <nav
        style={{
          width: 200,
          padding: "1rem",
          borderRight: "1px solid #eee",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.2rem" }}>Executor</h2>
        <Link to="/tools" style={{ textDecoration: "none", color: "#333" }}>
          Tools
        </Link>
        <Link to="/sources" style={{ textDecoration: "none", color: "#333" }}>
          Sources
        </Link>
        <Link to="/secrets" style={{ textDecoration: "none", color: "#333" }}>
          Secrets
        </Link>
      </nav>
      <main style={{ flex: 1, padding: "1.5rem" }}>{children}</main>
    </div>
  );
}
