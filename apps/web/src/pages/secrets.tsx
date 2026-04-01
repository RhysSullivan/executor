import { useAtomValue, Result, secretsAtom } from "@executor/react";

export function SecretsPage() {
  const secrets = useAtomValue(secretsAtom());

  return Result.match(secrets, {
    onInitial: () => <p>Loading secrets…</p>,
    onFailure: () => <p style={{ color: "red" }}>Failed to load secrets</p>,
    onSuccess: ({ value }) => (
      <div>
        <h2>Secrets ({value.length})</h2>
        {value.length === 0 ? (
          <p style={{ color: "#888" }}>No secrets stored yet.</p>
        ) : (
          <ul>
            {value.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong>
                {s.purpose && <span> — {s.purpose}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
  });
}
