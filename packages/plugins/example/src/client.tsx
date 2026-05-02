// ---------------------------------------------------------------------------
// @executor-js/plugin-example/client
//
// Frontend half: a single page that calls the plugin's `greet` mutation
// and renders the response. Demonstrates the typed reactive client
// pattern — `ExampleClient.mutation(...)` is fully typed against
// `ExampleApi` from `./shared` with no codegen.
//
// Server-only deps (Effect, Node, executor.config) MUST NOT be imported
// here — the Vite plugin bundles this entry into the frontend.
// ---------------------------------------------------------------------------

import { useState } from "react";
import {
  defineClientPlugin,
  createPluginAtomClient,
  useAtomSet,
} from "@executor-js/sdk/client";

import { ExampleApi } from "./shared";

const ExampleClient = createPluginAtomClient(ExampleApi);

const greetAtom = ExampleClient.mutation("example", "greet");

function ExamplePage() {
  const [name, setName] = useState("world");
  const [result, setResult] = useState<string>();
  const doGreet = useAtomSet(greetAtom, { mode: "promise" });

  return (
    <div style={{ maxWidth: 480, margin: "2rem auto", padding: "1rem" }}>
      <h1 style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>Example plugin</h1>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{
            flex: 1,
            padding: "0.5rem 0.75rem",
            border: "1px solid #ccc",
            borderRadius: 6,
          }}
        />
        <button
          type="button"
          onClick={async () => {
            const g = await doGreet({ payload: { name } });
            setResult(`${g.message} (#${g.count})`);
          }}
          style={{
            padding: "0.5rem 0.75rem",
            border: "1px solid #ccc",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Greet
        </button>
      </div>
      {result && (
        <pre style={{ marginTop: "1rem", padding: "0.5rem", background: "#f5f5f5" }}>
          {result}
        </pre>
      )}
    </div>
  );
}

export default defineClientPlugin({
  id: "example" as const,
  pages: [
    {
      path: "/",
      component: ExamplePage,
      nav: { label: "Example" },
    },
  ],
});
