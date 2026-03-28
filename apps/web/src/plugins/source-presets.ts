const GOOGLE_DISCOVERY_PLUGIN_KEY = "google-discovery" as const;
const GOOGLE_DISCOVERY_SOURCE_KIND = "google_discovery" as const;

export type SourcePreset =
  | {
      id: string;
      pluginKey: "mcp";
      kind: "mcp";
      name: string;
      summary: string;
      previewUrl: string;
      endpoint?: string;
      transport?: "auto" | "streamable-http" | "sse" | "stdio";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      id: string;
      pluginKey: "openapi";
      kind: "openapi";
      name: string;
      summary: string;
      previewUrl: string;
      baseUrl: string;
      specUrl: string;
    }
  | {
      id: string;
      pluginKey: "graphql";
      kind: "graphql";
      name: string;
      summary: string;
      previewUrl: string;
      endpoint: string;
    }
  | {
      id: string;
      pluginKey: typeof GOOGLE_DISCOVERY_PLUGIN_KEY;
      kind: typeof GOOGLE_DISCOVERY_SOURCE_KIND;
      name: string;
      summary: string;
      previewUrl: string;
      service: string;
      version: string;
      discoveryUrl: string;
    };

const googleDiscoveryPreset = (input: {
  id: string;
  name: string;
  summary: string;
  service: string;
  version: string;
  discoveryUrl: string;
}): SourcePreset => ({
  id: input.id,
  pluginKey: GOOGLE_DISCOVERY_PLUGIN_KEY,
  kind: GOOGLE_DISCOVERY_SOURCE_KIND,
  name: input.name,
  summary: input.summary,
  previewUrl: input.discoveryUrl,
  service: input.service,
  version: input.version,
  discoveryUrl: input.discoveryUrl,
});

export const sourcePresets: ReadonlyArray<SourcePreset> = [
  {
    id: "deepwiki-mcp",
    pluginKey: "mcp",
    kind: "mcp",
    name: "DeepWiki MCP",
    summary: "Repository docs and knowledge graphs via MCP.",
    previewUrl: "https://mcp.deepwiki.com/mcp",
    endpoint: "https://mcp.deepwiki.com/mcp",
    transport: "auto",
  },
  {
    id: "axiom-mcp",
    pluginKey: "mcp",
    kind: "mcp",
    name: "Axiom MCP",
    summary: "Query, stream, and analyze logs, traces, and event data.",
    previewUrl: "https://mcp.axiom.co/mcp",
    endpoint: "https://mcp.axiom.co/mcp",
    transport: "auto",
  },
  {
    id: "neon-mcp",
    pluginKey: "mcp",
    kind: "mcp",
    name: "Neon MCP",
    summary: "Manage Postgres databases, branches, and queries via MCP.",
    previewUrl: "https://mcp.neon.tech/mcp",
    endpoint: "https://mcp.neon.tech/mcp",
    transport: "auto",
  },
  {
    id: "chrome-devtools-mcp",
    pluginKey: "mcp",
    kind: "mcp",
    name: "Chrome DevTools MCP",
    summary: "Debug a live Chrome browser session over a local MCP stdio transport.",
    previewUrl: "npx -y chrome-devtools-mcp@latest",
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
  },
  {
    id: "neon-api",
    pluginKey: "openapi",
    kind: "openapi",
    name: "Neon API",
    summary: "Projects, branches, endpoints, databases, and API keys.",
    previewUrl: "https://console.neon.tech/api/v2",
    baseUrl: "https://console.neon.tech/api/v2",
    specUrl: "https://neon.com/api_spec/release/v2.json",
  },
  {
    id: "github-rest",
    pluginKey: "openapi",
    kind: "openapi",
    name: "GitHub REST API",
    summary: "Repos, issues, pull requests, actions, and org settings.",
    previewUrl: "https://api.github.com",
    baseUrl: "https://api.github.com",
    specUrl: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml",
  },
  {
    id: "github-graphql",
    pluginKey: "graphql",
    kind: "graphql",
    name: "GitHub GraphQL",
    summary: "Issues, pull requests, discussions, and repository objects via GraphQL.",
    previewUrl: "https://api.github.com/graphql",
    endpoint: "https://api.github.com/graphql",
  },
  {
    id: "gitlab-graphql",
    pluginKey: "graphql",
    kind: "graphql",
    name: "GitLab GraphQL",
    summary: "Projects, merge requests, issues, CI pipelines, and users.",
    previewUrl: "https://gitlab.com/api/graphql",
    endpoint: "https://gitlab.com/api/graphql",
  },
  {
    id: "openai-api",
    pluginKey: "openapi",
    kind: "openapi",
    name: "OpenAI API",
    summary: "Models, files, responses, and fine-tuning.",
    previewUrl: "https://api.openai.com/v1",
    baseUrl: "https://api.openai.com/v1",
    specUrl: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
  },
  {
    id: "vercel-api",
    pluginKey: "openapi",
    kind: "openapi",
    name: "Vercel API",
    summary: "Deployments, projects, domains, and environments.",
    previewUrl: "https://api.vercel.com",
    baseUrl: "https://api.vercel.com",
    specUrl: "https://openapi.vercel.sh",
  },
  {
    id: "stripe-api",
    pluginKey: "openapi",
    kind: "openapi",
    name: "Stripe API",
    summary: "Payments, billing, subscriptions, and invoices.",
    previewUrl: "https://api.stripe.com",
    baseUrl: "https://api.stripe.com",
    specUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  },
  {
    id: "linear-graphql",
    pluginKey: "graphql",
    kind: "graphql",
    name: "Linear GraphQL",
    summary: "Issues, teams, cycles, and projects.",
    previewUrl: "https://api.linear.app/graphql",
    endpoint: "https://api.linear.app/graphql",
  },
  {
    id: "monday-graphql",
    pluginKey: "graphql",
    kind: "graphql",
    name: "Monday GraphQL",
    summary: "Boards, items, updates, users, and workspace metadata.",
    previewUrl: "https://api.monday.com/v2",
    endpoint: "https://api.monday.com/v2",
  },
  {
    id: "anilist-graphql",
    pluginKey: "graphql",
    kind: "graphql",
    name: "AniList GraphQL",
    summary: "Anime, manga, characters, media lists, and recommendations.",
    previewUrl: "https://graphql.anilist.co",
    endpoint: "https://graphql.anilist.co",
  },
  googleDiscoveryPreset({
    id: "google-calendar",
    name: "Google Calendar",
    summary: "Calendars, events, ACLs, and scheduling workflows.",
    service: "calendar",
    version: "v3",
    discoveryUrl: "https://calendar-json.googleapis.com/$discovery/rest?version=v3",
  }),
  googleDiscoveryPreset({
    id: "google-drive",
    name: "Google Drive",
    summary: "Files, folders, permissions, comments, and shared drives.",
    service: "drive",
    version: "v3",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
  }),
  googleDiscoveryPreset({
    id: "google-gmail",
    name: "Gmail",
    summary: "Messages, threads, labels, drafts, and mailbox automation.",
    service: "gmail",
    version: "v1",
    discoveryUrl: "https://gmail.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-docs",
    name: "Google Docs",
    summary: "Documents, structural edits, text ranges, and formatting.",
    service: "docs",
    version: "v1",
    discoveryUrl: "https://docs.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-sheets",
    name: "Google Sheets",
    summary: "Spreadsheets, values, ranges, formatting, and batch updates.",
    service: "sheets",
    version: "v4",
    discoveryUrl: "https://sheets.googleapis.com/$discovery/rest?version=v4",
  }),
  googleDiscoveryPreset({
    id: "google-slides",
    name: "Google Slides",
    summary: "Presentations, slides, page elements, and deck updates.",
    service: "slides",
    version: "v1",
    discoveryUrl: "https://slides.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-forms",
    name: "Google Forms",
    summary: "Forms, questions, responses, quizzes, and form metadata.",
    service: "forms",
    version: "v1",
    discoveryUrl: "https://forms.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-search-console",
    name: "Google Search Console",
    summary: "Sites, sitemaps, URL inspection, and search and Discover performance.",
    service: "searchconsole",
    version: "v1",
    discoveryUrl: "https://searchconsole.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-people",
    name: "Google People",
    summary: "Contacts, profiles, directory people, and contact groups.",
    service: "people",
    version: "v1",
    discoveryUrl: "https://people.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-tasks",
    name: "Google Tasks",
    summary: "Task lists, task items, notes, and due dates.",
    service: "tasks",
    version: "v1",
    discoveryUrl: "https://tasks.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-chat",
    name: "Google Chat",
    summary: "Spaces, messages, members, reactions, and chat workflows.",
    service: "chat",
    version: "v1",
    discoveryUrl: "https://chat.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-keep",
    name: "Google Keep",
    summary: "Notes, lists, attachments, and collaborative annotations.",
    service: "keep",
    version: "v1",
    discoveryUrl: "https://keep.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-classroom",
    name: "Google Classroom",
    summary: "Courses, rosters, coursework, submissions, and grading data.",
    service: "classroom",
    version: "v1",
    discoveryUrl: "https://classroom.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-admin-directory",
    name: "Google Admin Directory",
    summary: "Users, groups, org units, roles, and domain directory resources.",
    service: "admin",
    version: "directory_v1",
    discoveryUrl: "https://admin.googleapis.com/$discovery/rest?version=directory_v1",
  }),
  googleDiscoveryPreset({
    id: "google-admin-reports",
    name: "Google Admin Reports",
    summary: "Audit events, usage reports, and admin activity logs.",
    service: "admin",
    version: "reports_v1",
    discoveryUrl: "https://admin.googleapis.com/$discovery/rest?version=reports_v1",
  }),
  googleDiscoveryPreset({
    id: "google-apps-script",
    name: "Google Apps Script",
    summary: "Projects, deployments, script execution, and Apps Script metadata.",
    service: "script",
    version: "v1",
    discoveryUrl: "https://script.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryPreset({
    id: "google-bigquery",
    name: "Google BigQuery",
    summary: "Datasets, tables, jobs, routines, and analytical query workflows.",
    service: "bigquery",
    version: "v2",
    discoveryUrl: "https://bigquery.googleapis.com/$discovery/rest?version=v2",
  }),
  googleDiscoveryPreset({
    id: "google-cloud-resource-manager",
    name: "Google Cloud Resource Manager",
    summary: "Projects, folders, organizations, and IAM-oriented resource hierarchy.",
    service: "cloudresourcemanager",
    version: "v3",
    discoveryUrl: "https://cloudresourcemanager.googleapis.com/$discovery/rest?version=v3",
  }),
  googleDiscoveryPreset({
    id: "google-youtube-data",
    name: "YouTube Data",
    summary: "Channels, playlists, videos, comments, captions, and uploads.",
    service: "youtube",
    version: "v3",
    discoveryUrl: "https://youtube.googleapis.com/$discovery/rest?version=v3",
  }),
] as const;

export const buildSourcePresetSearch = (
  preset: SourcePreset,
): Record<string, string> => {
  switch (preset.pluginKey) {
    case "openapi":
      return {
        preset: preset.id,
        presetName: preset.name,
        presetBaseUrl: preset.baseUrl,
        presetSpecUrl: preset.specUrl,
      };
    case "graphql":
      return {
        preset: preset.id,
        presetName: preset.name,
        presetEndpoint: preset.endpoint,
      };
    case "mcp":
      return {
        preset: preset.id,
        presetName: preset.name,
        ...(preset.endpoint ? { presetEndpoint: preset.endpoint } : {}),
        ...(preset.transport ? { presetTransport: preset.transport } : {}),
        ...(preset.command ? { presetCommand: preset.command } : {}),
        ...(preset.args ? { presetArgs: JSON.stringify(preset.args) } : {}),
        ...(preset.env ? { presetEnv: JSON.stringify(preset.env) } : {}),
        ...(preset.cwd ? { presetCwd: preset.cwd } : {}),
      };
    default:
      return {
        preset: preset.id,
        presetName: preset.name,
        presetService: preset.service,
        presetVersion: preset.version,
        presetDiscoveryUrl: preset.discoveryUrl,
      };
  }
};

const normalizeComparableUrl = (value: string): string => {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return trimmed;
  }
};

const tryParseUrl = (value: string): URL | null => {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
};

const sourceNameFromUrl = (url: URL, fallback: string): string => {
  const hostname = url.hostname.replace(/^www\./, "");
  if (hostname.length === 0) {
    return fallback;
  }

  const head = hostname.split(".")[0]?.trim();
  if (!head) {
    return fallback;
  }

  return `${head.charAt(0).toUpperCase()}${head.slice(1)} ${fallback}`;
};

const parseGoogleDiscoveryUrl = (value: string): {
  service: string;
  version: string;
  discoveryUrl: string;
} | null => {
  const url = tryParseUrl(value);
  if (!url) {
    return null;
  }

  const byDirectory = url.pathname.match(
    /^\/discovery\/v1\/apis\/([^/]+)\/([^/]+)\/rest$/,
  );
  if (byDirectory) {
    return {
      service: decodeURIComponent(byDirectory[1] ?? ""),
      version: decodeURIComponent(byDirectory[2] ?? ""),
      discoveryUrl: url.toString(),
    };
  }

  const versionParam = url.searchParams.get("version")?.trim();
  const isHostScopedDiscovery =
    url.pathname === "/$discovery/rest"
    && url.hostname.endsWith(".googleapis.com")
    && url.hostname !== "www.googleapis.com";

  if (versionParam && isHostScopedDiscovery) {
    const service = url.hostname.split(".")[0]?.trim();
    if (!service) {
      return null;
    }

    return {
      service,
      version: versionParam,
      discoveryUrl: url.toString(),
    };
  }

  return null;
};

const isGraphqlUrl = (url: URL): boolean => {
  const path = url.pathname.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return (
    path.endsWith("/graphql")
    || path === "/graphql"
    || hostname.startsWith("graphql.")
    || hostname.includes("graphql")
  );
};

const isMcpUrl = (url: URL): boolean => {
  const path = url.pathname.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return path.endsWith("/mcp") || path.includes("/mcp/") || hostname.startsWith("mcp.");
};

const isLikelyOpenApiSpecUrl = (url: URL): boolean => {
  const path = url.pathname.toLowerCase();
  return (
    path.endsWith(".json")
    || path.endsWith(".yaml")
    || path.endsWith(".yml")
    || path.includes("openapi")
    || path.includes("swagger")
  );
};

const findPresetByInput = (value: string): SourcePreset | null => {
  const comparable = normalizeComparableUrl(value);
  for (const preset of sourcePresets) {
    if (normalizeComparableUrl(preset.previewUrl) === comparable) {
      return preset;
    }

    if (preset.pluginKey === "openapi") {
      if (normalizeComparableUrl(preset.baseUrl) === comparable) {
        return preset;
      }
      if (normalizeComparableUrl(preset.specUrl) === comparable) {
        return preset;
      }
      continue;
    }

    if (preset.pluginKey === "graphql" || preset.pluginKey === "mcp") {
      if (preset.endpoint && normalizeComparableUrl(preset.endpoint) === comparable) {
        return preset;
      }
      continue;
    }

    if (normalizeComparableUrl(preset.discoveryUrl) === comparable) {
      return preset;
    }
  }

  return null;
};

export type ResolvedQuickSourceInput = {
  pluginKey: SourcePreset["pluginKey"];
  search: Record<string, string>;
};

export const resolveQuickSourceInput = (
  rawValue: string,
): ResolvedQuickSourceInput | null => {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const commandParts =
    trimmed.match(/[^\s"]+|"([^"]*)"/g)?.map((part) =>
      part.startsWith("\"") && part.endsWith("\"")
        ? part.slice(1, -1)
        : part
    ) ?? null;
  if (commandParts && commandParts.length > 0) {
    const [command, ...args] = commandParts;
    const isKnownCommand =
      command === "npx"
      || command === "bunx"
      || command === "uvx"
      || (command === "pnpm" && args[0] === "dlx");

    if (isKnownCommand) {
      return {
        pluginKey: "mcp",
        search: {
          presetName: "Local MCP",
          presetTransport: "stdio",
          presetCommand: command,
          ...(args.length > 0 ? { presetArgs: JSON.stringify(args) } : {}),
          quickInput: trimmed,
        },
      };
    }
  }

  const preset = findPresetByInput(trimmed);
  if (preset) {
    return {
      pluginKey: preset.pluginKey,
      search: buildSourcePresetSearch(preset),
    };
  }

  const googleDiscovery = parseGoogleDiscoveryUrl(trimmed);
  if (googleDiscovery) {
    const googlePreset = sourcePresets.find(
      (presetEntry) =>
        presetEntry.pluginKey === GOOGLE_DISCOVERY_PLUGIN_KEY
        && presetEntry.service === googleDiscovery.service
        && presetEntry.version === googleDiscovery.version,
    );

    return {
      pluginKey: GOOGLE_DISCOVERY_PLUGIN_KEY,
      search: {
        ...(googlePreset ? buildSourcePresetSearch(googlePreset) : {}),
        presetName:
          googlePreset?.name
          ?? `Google ${googleDiscovery.service} ${googleDiscovery.version}`,
        presetService: googleDiscovery.service,
        presetVersion: googleDiscovery.version,
        presetDiscoveryUrl: googleDiscovery.discoveryUrl,
        quickInput: trimmed,
      },
    };
  }

  const url = tryParseUrl(trimmed);
  if (!url) {
    return null;
  }

  if (isGraphqlUrl(url)) {
    return {
      pluginKey: "graphql",
      search: {
        presetName: sourceNameFromUrl(url, "GraphQL"),
        presetEndpoint: trimmed,
        quickInput: trimmed,
      },
    };
  }

  if (isMcpUrl(url)) {
    return {
      pluginKey: "mcp",
      search: {
        presetName: sourceNameFromUrl(url, "MCP"),
        presetEndpoint: trimmed,
        presetTransport: "auto",
        quickInput: trimmed,
      },
    };
  }

  if (isLikelyOpenApiSpecUrl(url)) {
    return {
      pluginKey: "openapi",
      search: {
        presetName: sourceNameFromUrl(url, "OpenAPI"),
        presetSpecUrl: trimmed,
        quickInput: trimmed,
      },
    };
  }

  return {
    pluginKey: "openapi",
    search: {
      presetName: sourceNameFromUrl(url, "OpenAPI"),
      presetBaseUrl: trimmed,
      quickInput: trimmed,
    },
  };
};
