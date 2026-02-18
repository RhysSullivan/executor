import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Id } from "@executor/database/convex/_generated/dataModel";

export type LinkedProvider = "anonymous" | "workos";

export interface LinkedMcpContext {
  readonly provider: LinkedProvider;
  readonly workspaceId: Id<"workspaces">;
  readonly accountId?: string;
  readonly sessionId?: string;
  readonly accessToken?: string;
  readonly mcpApiKey?: string;
  readonly clientId?: string;
  readonly linkedAt: number;
}

interface LinkStoreFile {
  readonly version: 1;
  readonly links: Record<string, LinkedMcpContext>;
}

export const defaultLinksFilePath = new URL("../../../.chat-links.json", import.meta.url).pathname;

export function createFileLinkStore(filePath = Bun.env.ASSISTANT_LINKS_FILE ?? defaultLinksFilePath) {
  let loaded = false;
  let links: Record<string, LinkedMcpContext> = {};

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;

    const file = Bun.file(filePath);
    if (!(await file.exists())) return;

    const text = await file.text();
    if (!text.trim()) return;

    try {
      const parsed = JSON.parse(text) as {
        version?: number;
        links?: Record<string, LinkedMcpContext>;
      };
      if (parsed && parsed.version === 1 && parsed.links && typeof parsed.links === "object") {
        links = parsed.links;
      }
    } catch (error) {
      console.error(`[assistant] Failed to parse link store '${filePath}':`, error);
    }
  }

  async function persist() {
    await mkdir(dirname(filePath), { recursive: true });
    const payload: LinkStoreFile = { version: 1, links };
    await Bun.write(filePath, JSON.stringify(payload, null, 2));
  }

  return {
    filePath,

    async get(identityKey: string): Promise<LinkedMcpContext | undefined> {
      await ensureLoaded();
      return links[identityKey];
    },

    async set(identityKey: string, value: LinkedMcpContext): Promise<void> {
      await ensureLoaded();
      links[identityKey] = value;
      await persist();
    },

    async delete(identityKey: string): Promise<boolean> {
      await ensureLoaded();
      if (!links[identityKey]) return false;
      delete links[identityKey];
      await persist();
      return true;
    },
  };
}
