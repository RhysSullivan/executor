import type { Source } from "@executor/react";

type SourceTemplateBase = {
  id: string;
  name: string;
  summary: string;
  endpoint: string;
};

export type OpenApiSourceTemplate = SourceTemplateBase & {
  kind: "openapi";
  specUrl: string;
};

export type GoogleDiscoverySourceTemplate = SourceTemplateBase & {
  kind: "google_discovery";
  service: string;
  version: string;
  discoveryUrl: string;
};

export type NonOpenApiSourceTemplate = SourceTemplateBase & {
  kind: Exclude<Source["kind"], "openapi" | "google_discovery" | "internal">;
};

export type SourceTemplate =
  | OpenApiSourceTemplate
  | GoogleDiscoverySourceTemplate
  | NonOpenApiSourceTemplate;

const googleDiscoveryUrl = (service: string, version: string): string =>
  `https://www.googleapis.com/discovery/v1/apis/${encodeURIComponent(service)}/${encodeURIComponent(version)}/rest`;

const googleDiscoveryTemplate = (input: {
  id: string;
  name: string;
  summary: string;
  service: string;
  version: string;
  discoveryUrl?: string;
}): GoogleDiscoverySourceTemplate => {
  const discoveryUrl = input.discoveryUrl ?? googleDiscoveryUrl(input.service, input.version);
  return {
    id: input.id,
    name: input.name,
    summary: input.summary,
    kind: "google_discovery",
    endpoint: discoveryUrl,
    service: input.service,
    version: input.version,
    discoveryUrl,
  };
};

export const sourceTemplates: ReadonlyArray<SourceTemplate> = [
  {
    id: "deepwiki-mcp",
    name: "DeepWiki MCP",
    summary: "Repository docs and knowledge graphs via MCP.",
    kind: "mcp",
    endpoint: "https://mcp.deepwiki.com/mcp",
  },
  {
    id: "axiom-mcp",
    name: "Axiom MCP",
    summary: "Query, stream, and analyze logs, traces, and event data.",
    kind: "mcp",
    endpoint: "https://mcp.axiom.co/mcp",
  },
  {
    id: "neon-mcp",
    name: "Neon MCP",
    summary: "Manage Postgres databases, branches, and queries via MCP.",
    kind: "mcp",
    endpoint: "https://mcp.neon.tech/mcp",
  },
  {
    id: "neon-api",
    name: "Neon API",
    summary: "Projects, branches, endpoints, databases, and API keys.",
    kind: "openapi",
    endpoint: "https://console.neon.tech/api/v2",
    specUrl: "https://neon.com/api_spec/release/v2.json",
  },
  {
    id: "github-rest",
    name: "GitHub REST API",
    summary: "Repos, issues, pull requests, actions, and org settings.",
    kind: "openapi",
    endpoint: "https://api.github.com",
    specUrl: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml",
  },
  {
    id: "github-graphql",
    name: "GitHub GraphQL",
    summary: "Issues, pull requests, discussions, and repository objects via GraphQL.",
    kind: "graphql",
    endpoint: "https://api.github.com/graphql",
  },
  {
    id: "gitlab-graphql",
    name: "GitLab GraphQL",
    summary: "Projects, merge requests, issues, CI pipelines, and users.",
    kind: "graphql",
    endpoint: "https://gitlab.com/api/graphql",
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    summary: "Models, files, responses, and fine-tuning.",
    kind: "openapi",
    endpoint: "https://api.openai.com/v1",
    specUrl: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
  },
  {
    id: "vercel-api",
    name: "Vercel API",
    summary: "Deployments, projects, domains, and environments.",
    kind: "openapi",
    endpoint: "https://api.vercel.com",
    specUrl: "https://openapi.vercel.sh",
  },
  {
    id: "stripe-api",
    name: "Stripe API",
    summary: "Payments, billing, subscriptions, and invoices.",
    kind: "openapi",
    endpoint: "https://api.stripe.com",
    specUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  },
  {
    id: "linear-graphql",
    name: "Linear GraphQL",
    summary: "Issues, teams, cycles, and projects.",
    kind: "graphql",
    endpoint: "https://api.linear.app/graphql",
  },
  {
    id: "monday-graphql",
    name: "Monday GraphQL",
    summary: "Boards, items, updates, users, and workspace metadata.",
    kind: "graphql",
    endpoint: "https://api.monday.com/v2",
  },
  {
    id: "anilist-graphql",
    name: "AniList GraphQL",
    summary: "Anime, manga, characters, media lists, and recommendations.",
    kind: "graphql",
    endpoint: "https://graphql.anilist.co",
  },
  googleDiscoveryTemplate({
    id: "google-calendar",
    name: "Google Calendar",
    summary: "Calendars, events, ACLs, and scheduling workflows.",
    service: "calendar",
    version: "v3",
    discoveryUrl: "https://calendar-json.googleapis.com/$discovery/rest?version=v3",
  }),
  googleDiscoveryTemplate({
    id: "google-drive",
    name: "Google Drive",
    summary: "Files, folders, permissions, comments, and shared drives.",
    service: "drive",
    version: "v3",
  }),
  googleDiscoveryTemplate({
    id: "google-gmail",
    name: "Gmail",
    summary: "Messages, threads, labels, drafts, and mailbox automation.",
    service: "gmail",
    version: "v1",
    discoveryUrl: "https://gmail.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-docs",
    name: "Google Docs",
    summary: "Documents, structural edits, text ranges, and formatting.",
    service: "docs",
    version: "v1",
    discoveryUrl: "https://docs.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-sheets",
    name: "Google Sheets",
    summary: "Spreadsheets, values, ranges, formatting, and batch updates.",
    service: "sheets",
    version: "v4",
    discoveryUrl: "https://sheets.googleapis.com/$discovery/rest?version=v4",
  }),
  googleDiscoveryTemplate({
    id: "google-slides",
    name: "Google Slides",
    summary: "Presentations, slides, page elements, and deck updates.",
    service: "slides",
    version: "v1",
    discoveryUrl: "https://slides.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-forms",
    name: "Google Forms",
    summary: "Forms, questions, responses, quizzes, and form metadata.",
    service: "forms",
    version: "v1",
    discoveryUrl: "https://forms.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-search-console",
    name: "Google Search Console",
    summary: "Sites, sitemaps, URL inspection, and search and Discover performance.",
    service: "searchconsole",
    version: "v1",
    discoveryUrl: "https://searchconsole.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-people",
    name: "Google People",
    summary: "Contacts, profiles, directory people, and contact groups.",
    service: "people",
    version: "v1",
    discoveryUrl: "https://people.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-tasks",
    name: "Google Tasks",
    summary: "Task lists, task items, notes, and due dates.",
    service: "tasks",
    version: "v1",
    discoveryUrl: "https://tasks.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-chat",
    name: "Google Chat",
    summary: "Spaces, messages, members, reactions, and chat workflows.",
    service: "chat",
    version: "v1",
    discoveryUrl: "https://chat.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-keep",
    name: "Google Keep",
    summary: "Notes, lists, attachments, and collaborative annotations.",
    service: "keep",
    version: "v1",
    discoveryUrl: "https://keep.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-classroom",
    name: "Google Classroom",
    summary: "Courses, rosters, coursework, submissions, and grading data.",
    service: "classroom",
    version: "v1",
    discoveryUrl: "https://classroom.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-admin-directory",
    name: "Google Admin Directory",
    summary: "Users, groups, org units, roles, and domain directory resources.",
    service: "admin",
    version: "directory_v1",
    discoveryUrl: "https://admin.googleapis.com/$discovery/rest?version=directory_v1",
  }),
  googleDiscoveryTemplate({
    id: "google-admin-reports",
    name: "Google Admin Reports",
    summary: "Audit events, usage reports, and admin activity logs.",
    service: "admin",
    version: "reports_v1",
    discoveryUrl: "https://admin.googleapis.com/$discovery/rest?version=reports_v1",
  }),
  googleDiscoveryTemplate({
    id: "google-apps-script",
    name: "Google Apps Script",
    summary: "Projects, deployments, script execution, and Apps Script metadata.",
    service: "script",
    version: "v1",
    discoveryUrl: "https://script.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-bigquery",
    name: "Google BigQuery",
    summary: "Datasets, tables, jobs, routines, and analytical query workflows.",
    service: "bigquery",
    version: "v2",
    discoveryUrl: "https://bigquery.googleapis.com/$discovery/rest?version=v2",
  }),
  googleDiscoveryTemplate({
    id: "google-cloud-resource-manager",
    name: "Google Cloud Resource Manager",
    summary: "Projects, folders, organizations, and IAM-oriented resource hierarchy.",
    service: "cloudresourcemanager",
    version: "v3",
    discoveryUrl: "https://cloudresourcemanager.googleapis.com/$discovery/rest?version=v3",
  }),
  googleDiscoveryTemplate({
    id: "google-youtube-data",
    name: "YouTube Data",
    summary: "Channels, playlists, videos, comments, captions, and uploads.",
    service: "youtube",
    version: "v3",
    discoveryUrl: "https://youtube.googleapis.com/$discovery/rest?version=v3",
  }),
];
