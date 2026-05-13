import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ExistingServerCandidate {
  readonly baseUrl: string;
}

export interface ExistingServerMatch {
  readonly baseUrl: string;
  readonly port: number;
  readonly scopeDir: string;
}

interface ScopeResponse {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
}

interface DaemonPointer {
  readonly version: 1;
  readonly hostname: string;
  readonly port: number;
  readonly pid: number;
  readonly scopeId: string;
  readonly scopeDir: string | null;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 500;
const LOCAL_DAEMON_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const isScopeResponse = (value: unknown): value is ScopeResponse =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).id === "string" &&
  typeof (value as Record<string, unknown>).name === "string" &&
  typeof (value as Record<string, unknown>).dir === "string";

const isDaemonPointer = (value: unknown): value is DaemonPointer => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.hostname === "string" &&
    typeof record.port === "number" &&
    typeof record.pid === "number" &&
    typeof record.scopeId === "string" &&
    (typeof record.scopeDir === "string" || record.scopeDir === null)
  );
};

const normalizeDir = (dir: string): string => dir.replace(/\/+$/, "");

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const portFromBaseUrl = (baseUrl: string): number => {
  const parsed = new URL(baseUrl);
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  return port;
};

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: process probing uses Node's throwing kill(pid, 0) API
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const defaultDataDir = (): string => join(homedir(), ".executor");

export const defaultDesktopScopeDir = (): string => join(homedir(), ".executor-global");

export const discoverPointerCandidates = async (input: {
  readonly scopeDir: string;
  readonly dataDir?: string;
  readonly readDirImpl?: typeof readdir;
  readonly readFileImpl?: typeof readFile;
  readonly isPidAliveImpl?: (pid: number) => boolean;
}): Promise<ReadonlyArray<ExistingServerCandidate>> => {
  const expectedScopeDir = normalizeDir(input.scopeDir);
  const dataDir = input.dataDir ?? defaultDataDir();
  const readDirImpl = input.readDirImpl ?? readdir;
  const readFileImpl = input.readFileImpl ?? readFile;
  const isPidAliveImpl = input.isPidAliveImpl ?? isPidAlive;
  let entries: ReadonlyArray<string>;

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: discovery must tolerate missing daemon state directory
  try {
    entries = await readDirImpl(dataDir);
  } catch {
    return [];
  }

  const candidates: Array<ExistingServerCandidate> = [];
  for (const entry of entries) {
    if (!entry.startsWith("daemon-active-localhost-") || !entry.endsWith(".json")) continue;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: discovery must tolerate stale or malformed daemon pointer files
    try {
      const raw = await readFileImpl(join(dataDir, entry), "utf8");
      // oxlint-disable-next-line executor/no-json-parse -- boundary: daemon pointer discovery validates unknown JSON with isDaemonPointer before use
      const parsed = JSON.parse(raw) as unknown;
      if (!isDaemonPointer(parsed)) continue;
      if (!parsed.scopeDir || normalizeDir(parsed.scopeDir) !== expectedScopeDir) continue;
      if (!LOCAL_DAEMON_HOSTS.has(parsed.hostname.toLowerCase())) continue;
      if (!isPidAliveImpl(parsed.pid)) continue;

      candidates.push({ baseUrl: `http://127.0.0.1:${parsed.port}` });
    } catch {
      continue;
    }
  }

  return candidates;
};

export const discoverExistingLocalServer = async (input: {
  readonly scopeDir: string;
  readonly candidates?: ReadonlyArray<ExistingServerCandidate>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<ExistingServerMatch | null> => {
  const candidates =
    input.candidates ?? (await discoverPointerCandidates({ scopeDir: input.scopeDir }));
  const timeoutMs = input.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const expectedScopeDir = normalizeDir(input.scopeDir);

  for (const candidate of candidates) {
    const baseUrl = normalizeBaseUrl(candidate.baseUrl);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: discovery must tolerate stale or unrelated local listeners
    try {
      const response = await fetchImpl(`${baseUrl}/api/scope`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;

      const payload = await response.json();
      if (!isScopeResponse(payload)) continue;
      if (normalizeDir(payload.dir) !== expectedScopeDir) continue;

      return {
        baseUrl,
        port: portFromBaseUrl(baseUrl),
        scopeDir: payload.dir,
      };
    } catch {
      continue;
    }
  }

  return null;
};
