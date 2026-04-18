"use client";

import { useState } from "react";
import { useAtomSet, useAtomRefresh } from "@effect-atom/atom-react";

import { SecretId } from "@executor/sdk";
import { secretsAtom, setSecret } from "../api/atoms";
import { useScope } from "../api/scope-context";
import { Button } from "../components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { Input } from "../components/input";
import { Label } from "../components/label";

/**
 * Dialog for creating a new secret in the current scope. On success calls
 * `onCreated(secretId)` and closes itself via `onOpenChange(false)`.
 */
export function AddSecretDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (secretId: string) => void;
}) {
  const [secretId, setSecretId] = useState("");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeId = useScope();
  const doSet = useAtomSet(setSecret, { mode: "promise" });
  const refreshSecrets = useAtomRefresh(secretsAtom(scopeId));

  const handleSave = async () => {
    if (!secretId.trim() || !secretValue.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await doSet({
        path: { scopeId },
        payload: {
          id: SecretId.make(secretId.trim()),
          name: secretName.trim() || secretId.trim(),
          value: secretValue.trim(),
        },
      });
      refreshSecrets();
      props.onCreated(secretId.trim());
      // Reset form
      setSecretId("");
      setSecretName("");
      setSecretValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save secret");
      setSaving(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setSecretId("");
      setSecretName("");
      setSecretValue("");
      setError(null);
      setSaving(false);
    }
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Secret</DialogTitle>
          <DialogDescription>
            Create a new secret to use for authentication. The value is stored securely and never
            exposed in plaintext.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">ID</Label>
              <Input
                value={secretId}
                onChange={(e) => setSecretId((e.target as HTMLInputElement).value)}
                placeholder="my-api-key"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Label</Label>
              <Input
                value={secretName}
                onChange={(e) => setSecretName((e.target as HTMLInputElement).value)}
                placeholder="My API Key"
                className="text-sm"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Value</Label>
            <Input
              type="password"
              value={secretValue}
              onChange={(e) => setSecretValue((e.target as HTMLInputElement).value)}
              placeholder="paste your secret value…"
              className="font-mono text-sm"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!secretId.trim() || !secretValue.trim() || saving}>
            {saving ? "Creating…" : "Create secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
