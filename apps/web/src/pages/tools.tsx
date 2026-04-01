import { useAtomValue, Result, toolsAtom } from "@executor/react";

export function ToolsPage() {
  const tools = useAtomValue(toolsAtom());

  return Result.match(tools, {
    onInitial: () => <p>Loading tools…</p>,
    onFailure: () => <p style={{ color: "red" }}>Failed to load tools</p>,
    onSuccess: ({ value }) => (
      <div>
        <h2>Tools ({value.length})</h2>
        {value.length === 0 ? (
          <p style={{ color: "#888" }}>No tools registered yet.</p>
        ) : (
          <ul>
            {value.map((t) => (
              <li key={t.id}>
                <strong>{t.name}</strong>
                {t.description && <span> — {t.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
  });
}
