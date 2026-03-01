#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface ListOrigin {
  format: string;
  url: string;
  version: string;
}

interface ListVersionInfo {
  title?: string;
  version?: string;
  "x-origin"?: ListOrigin[];
  "x-providerName"?: string;
}

interface ListVersion {
  info: ListVersionInfo;
  swaggerUrl: string;
  openapiVer?: string;
}

interface ListEntry {
  preferred: string;
  versions: Record<string, ListVersion>;
}

type ListJson = Record<string, ListEntry>;

interface ApisGuruMatch {
  id: string;
  name: string;
  providerName: string;
  specUrl: string;
  originUrl: string;
  openapiVer: string;
}

interface ToolkitRecord {
  slug: string;
  docsUrl: string;
  toolkitUrl: string;
  name: string;
  category: string;
  auth: string;
  toolsCount: number;
  triggersCount: number;
  composioSlug: string;
  version: string;
  status: "ok" | "missing" | "error";
  protocolHints: string[];
  endpointUrls: string[];
  usableOpenApiUrls: string[];
  usableGraphqlUrls: string[];
  matchedApisGuru: ApisGuruMatch | null;
  error: string;
}

const TOOLKITS_SITEMAP_URL = "https://composio.dev/toolkits/sitemap.xml";
const DOCS_BASE_URL = "https://docs.composio.dev/toolkits/";
const APIS_GURU_URL = "https://api.apis.guru/v2/list.json";

const defaultConcurrency = parseIntArg("--concurrency", 10, 1, 50);
const limit = parseIntArg("--limit", 0, 0, 20_000);
const only = getStringArg("--only");

function getStringArg(flag: string): string {
  const value = Bun.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!value) return "";
  return value.slice(flag.length + 1).trim();
}

function parseIntArg(flag: string, fallback: number, min: number, max: number): number {
  const value = getStringArg(flag);
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

const MATCH_STOPWORDS = new Set([
  "api",
  "apis",
  "app",
  "apps",
  "sdk",
  "www",
  "com",
  "net",
  "org",
  "io",
  "dev",
]);

function tokenizeNormalized(value: string): string[] {
  const expanded = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2");

  const tokens = expanded
    .split(/[^a-zA-Z0-9]+/g)
    .map((token) => normalize(token))
    .filter((token) => token.length >= 3 && !MATCH_STOPWORDS.has(token));

  return [...new Set(tokens)];
}

function parseSitemap(xml: string): string[] {
  const slugs = new Set<string>();

  for (const match of xml.matchAll(/<loc>https:\/\/composio\.dev\/toolkits\/([^<]+)<\/loc>/g)) {
    const slug = decodeURIComponent(match[1]).trim();
    if (!slug || slug === "toolkits") continue;
    if (slug.includes("/")) continue;
    slugs.add(slug);
  }

  return [...slugs].sort();
}

function parseMarkdownField(markdown: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^-\\s+\\*\\*${escaped}:\\*\\*\\s*(.+)$`, "im");
  return (markdown.match(regex)?.[1] ?? "").trim();
}

function parseHeading(markdown: string): string {
  for (const match of markdown.matchAll(/^#\s+(.+)$/gm)) {
    const heading = match[1].trim();
    if (heading.length > 0) return heading;
  }
  return "";
}

function toNumber(value: string): number {
  const parsed = Number(value.replace(/[^0-9]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractUrls(markdown: string): string[] {
  const urls = new Set<string>();
  const matches = markdown.matchAll(/https?:\/\/[^\s)\]>"]+/g);

  for (const match of matches) {
    const raw = match[0].trim();
    const clean = raw
      .replace(/[),.;'"`]+$/g, "")
      .replace(/\\+$/g, "")
      .replace(/&amp;/g, "&");
    if (!clean) continue;

    try {
      new URL(clean);
    } catch {
      continue;
    }

    urls.add(clean);
  }

  return [...urls].sort();
}

function extractEndpointUrls(markdown: string): string[] {
  const urls = new Set<string>();

  for (const clean of extractUrls(markdown)) {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    const value = clean.toLowerCase();

    const looksEndpointLike =
      /openapi|swagger|graphql|developers?\.|api\.|\/api\//.test(value) ||
      /developers?/.test(parsed.pathname.toLowerCase());

    if (!looksEndpointLike) continue;
    if (host.endsWith("composio.dev")) continue;

    urls.add(clean);
  }

  return [...urls].sort();
}

function extractUsableSpecUrls(markdown: string, matchedApisGuru: ApisGuruMatch | null): {
  openapiUrls: string[];
  graphqlUrls: string[];
} {
  const openapiUrls = new Set<string>();
  const graphqlUrls = new Set<string>();

  if (matchedApisGuru?.specUrl) {
    openapiUrls.add(matchedApisGuru.specUrl);
  }

  for (const url of extractUrls(markdown)) {
    const lower = url.toLowerCase();

    if (/\/graphql($|[/?#])/i.test(url) || /graphql\./i.test(lower)) {
      graphqlUrls.add(url);
    }

    const looksLikeOpenApiSpec =
      /(openapi|swagger)[^\s]*(\.json|\.ya?ml)($|[?#])/i.test(lower) ||
      /\/(openapi|swagger)(\.json|\.ya?ml|$|[/?#])/i.test(lower) ||
      /\/(v3\/api-docs|api-docs)($|[/?#])/i.test(lower);

    if (looksLikeOpenApiSpec) {
      openapiUrls.add(url);
    }
  }

  return {
    openapiUrls: [...openapiUrls].sort(),
    graphqlUrls: [...graphqlUrls].sort(),
  };
}

function detectProtocolHints(markdown: string, slug: string, endpointUrls: string[], toolsCount: number): string[] {
  const hints = new Set<string>();
  const allText = `${slug}\n${markdown}`.toLowerCase();

  if (/graphql/.test(allText) || endpointUrls.some((url) => /graphql/i.test(url))) {
    hints.add("graphql");
  }
  if (/openapi|swagger/.test(allText) || endpointUrls.some((url) => /openapi|swagger/i.test(url))) {
    hints.add("openapi");
  }

  if (hints.size === 0 && toolsCount > 0) {
    hints.add("rest_or_rpc");
  }
  if (hints.size === 0) {
    hints.add("unknown");
  }

  return [...hints];
}

function buildApisGuruIndex(data: ListJson): Map<string, ApisGuruMatch[]> {
  const index = new Map<string, ApisGuruMatch[]>();

  for (const [id, entry] of Object.entries(data)) {
    const preferred = entry.versions[entry.preferred];
    if (!preferred?.swaggerUrl) continue;

    const info = preferred.info;
    const match: ApisGuruMatch = {
      id,
      name: (info.title ?? id).trim(),
      providerName: (info["x-providerName"] ?? id).trim(),
      specUrl: preferred.swaggerUrl,
      originUrl: info["x-origin"]?.[0]?.url ?? "",
      openapiVer: preferred.openapiVer ?? "",
    };

    const keys = new Set<string>([
      normalize(id),
      normalize(match.name),
      normalize(match.providerName),
      normalize(id.replace(/[_.-]/g, " ")),
      normalize(match.name.replace(/[_.-]/g, " ")),
      normalize(match.providerName.replace(/[_.-]/g, " ")),
    ]);

    for (const token of tokenizeNormalized(id)) {
      keys.add(token);
    }

    for (const token of tokenizeNormalized(match.name)) {
      keys.add(token);
    }

    for (const token of tokenizeNormalized(match.providerName)) {
      keys.add(token);
    }

    for (const key of keys) {
      if (!key) continue;
      const current = index.get(key) ?? [];
      current.push(match);
      index.set(key, current);
    }
  }

  return index;
}

function chooseApisGuruMatch(
  slug: string,
  name: string,
  composioSlug: string,
  index: Map<string, ApisGuruMatch[]>,
): ApisGuruMatch | null {
  const candidates = [
    slug,
    slug.replace(/[_-]/g, " "),
    name,
    composioSlug,
    composioSlug.replace(/[_-]/g, " "),
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  const primaryKeys = new Set(candidates.map(normalize).filter(Boolean));
  const tokenKeys = new Set<string>();
  for (const value of candidates) {
    for (const token of tokenizeNormalized(value)) {
      tokenKeys.add(token);
    }
  }

  for (const key of primaryKeys) {
    if (!key.startsWith("google") || key.length <= 6) continue;

    const service = key.slice(6);
    if (!service) continue;

    const googleMatches = (index.get(service) ?? [])
      .filter((match) => normalize(match.id).startsWith("googleapiscom"));

    if (googleMatches.length === 1) {
      return googleMatches[0];
    }

    const idExact = googleMatches.find((match) => normalize(match.id).endsWith(service));
    if (idExact) return idExact;

    const nameExact = googleMatches.find((match) => {
      const words = tokenizeNormalized(match.name);
      return words.includes(service);
    });

    if (nameExact) return nameExact;
  }

  const lookupKeys = new Set<string>([...primaryKeys, ...tokenKeys]);
  const pool: ApisGuruMatch[] = [];

  for (const key of lookupKeys) {
    const matches = index.get(key);
    if (!matches) continue;
    pool.push(...matches);
  }

  if (pool.length === 0) return null;

  const unique = new Map<string, ApisGuruMatch>();
  for (const item of pool) unique.set(item.id, item);

  const scored = [...unique.values()].map((match) => {
    const idN = normalize(match.id);
    const nameN = normalize(match.name);
    const providerN = normalize(match.providerName);

    let score = 0;

    for (const key of primaryKeys) {
      if (key === idN) score = Math.max(score, 100);
      if (key === nameN) score = Math.max(score, 99);
      if (key === providerN) score = Math.max(score, 98);
      if (idN.endsWith(key)) score = Math.max(score, 96);
      if (idN.startsWith(key)) score = Math.max(score, 94);
      if (nameN.startsWith(key) || nameN.endsWith(key)) score = Math.max(score, 93);
      if (nameN.includes(key) && key.length >= 8) score = Math.max(score, 92);
      if (idN.includes(key) && key.length >= 8) score = Math.max(score, 90);
      if (providerN.includes(key) && key.length >= 8) score = Math.max(score, 88);
      if (idN.includes(key) || key.includes(idN)) score = Math.max(score, 84);
      if (nameN.includes(key) || key.includes(nameN)) score = Math.max(score, 82);
      if (providerN.includes(key) || key.includes(providerN)) score = Math.max(score, 80);
    }

    for (const key of tokenKeys) {
      if (key === idN) score = Math.max(score, 90);
      if (key === nameN) score = Math.max(score, 88);
      if (key === providerN) score = Math.max(score, 86);
      if (idN.includes(key)) score = Math.max(score, 76);
      if (nameN.includes(key)) score = Math.max(score, 74);
      if (providerN.includes(key)) score = Math.max(score, 72);
    }

    return { match, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (!best) return null;

  const margin = best.score - (second?.score ?? 0);
  if (best.score >= 92) return best.match;
  if (best.score >= 86 && margin >= 8) return best.match;

  return null;
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "composio-toolkit-scraper/1.0",
          "accept": "text/plain,text/markdown,text/html,*/*",
        },
      });

      if (!response.ok) {
        if (response.status === 404) return { status: 404, text: "" };
        throw new Error(`HTTP ${response.status}`);
      }

      return { status: response.status, text: await response.text() };
    } catch (error) {
      lastError = error;
      await Bun.sleep(250 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

function toCsv(rows: ToolkitRecord[]): string {
  const headers = [
    "slug",
    "name",
    "category",
    "auth",
    "toolsCount",
    "triggersCount",
    "composioSlug",
    "version",
    "status",
    "protocolHints",
    "endpointUrls",
    "usableOpenApiUrls",
    "usableGraphqlUrls",
    "apisGuruId",
    "apisGuruProviderName",
    "apisGuruSpecUrl",
    "apisGuruOriginUrl",
    "apisGuruOpenApiVer",
    "docsUrl",
    "toolkitUrl",
    "error",
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    const values = [
      row.slug,
      row.name,
      row.category,
      row.auth,
      String(row.toolsCount),
      String(row.triggersCount),
      row.composioSlug,
      row.version,
      row.status,
      row.protocolHints.join(";"),
      row.endpointUrls.join(";"),
      row.usableOpenApiUrls.join(";"),
      row.usableGraphqlUrls.join(";"),
      row.matchedApisGuru?.id ?? "",
      row.matchedApisGuru?.providerName ?? "",
      row.matchedApisGuru?.specUrl ?? "",
      row.matchedApisGuru?.originUrl ?? "",
      row.matchedApisGuru?.openapiVer ?? "",
      row.docsUrl,
      row.toolkitUrl,
      row.error,
    ];

    lines.push(values.map(csvEscape).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function csvEscape(value: string): string {
  if (/[\",\n]/.test(value)) {
    return `"${value.replace(/\"/g, "\"\"")}"`;
  }
  return value;
}

function toNeedsResearchCsv(rows: ToolkitRecord[]): string {
  const headers = ["slug", "name", "category", "auth", "docsUrl", "toolkitUrl"];
  const lines = [headers.join(",")];

  const filtered = rows
    .filter((row) => row.status === "ok" && row.usableOpenApiUrls.length === 0 && row.usableGraphqlUrls.length === 0)
    .sort((a, b) => a.slug.localeCompare(b.slug));

  for (const row of filtered) {
    lines.push([
      row.slug,
      row.name,
      row.category,
      row.auth,
      row.docsUrl,
      row.toolkitUrl,
    ].map(csvEscape).join(","));
  }

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  console.log("[composio] fetching toolkit sitemap...");
  const sitemap = await fetchText(TOOLKITS_SITEMAP_URL);
  const allSlugs = parseSitemap(sitemap.text);

  const targetSlugs =
    only.length > 0
      ? allSlugs.filter((slug) => slug === only)
      : (limit > 0 ? allSlugs.slice(0, limit) : allSlugs);

  if (targetSlugs.length === 0) {
    throw new Error("No toolkit slugs to process. Check --only or sitemap availability.");
  }

  console.log(`[composio] discovered ${allSlugs.length} toolkits (processing ${targetSlugs.length})`);
  console.log("[composio] fetching APIs.guru list for OpenAPI matching...");

  let apisGuruIndex = new Map<string, ApisGuruMatch[]>();
  try {
    const listResponse = await fetchText(APIS_GURU_URL);
    const list = JSON.parse(listResponse.text) as ListJson;
    apisGuruIndex = buildApisGuruIndex(list);
    console.log(`[composio] loaded APIs.guru index keys: ${apisGuruIndex.size}`);
  } catch (error) {
    console.warn(`[composio] warning: failed to load APIs.guru list (${error instanceof Error ? error.message : String(error)})`);
  }

  let completed = 0;

  const records = await mapLimit(targetSlugs, defaultConcurrency, async (slug): Promise<ToolkitRecord> => {
    const docsUrl = `${DOCS_BASE_URL}${slug}`;
    const toolkitUrl = `https://composio.dev/toolkits/${slug}`;

    try {
      const response = await fetchText(docsUrl);

      if (response.status === 404) {
        return {
          slug,
          docsUrl,
          toolkitUrl,
          name: "",
          category: "",
          auth: "",
          toolsCount: 0,
          triggersCount: 0,
          composioSlug: "",
          version: "",
          status: "missing",
          protocolHints: ["unknown"],
          endpointUrls: [],
          usableOpenApiUrls: [],
          usableGraphqlUrls: [],
          matchedApisGuru: null,
          error: "docs page not found",
        };
      }

      const markdown = response.text;
      const name = parseHeading(markdown);
      const category = parseMarkdownField(markdown, "Category");
      const auth = parseMarkdownField(markdown, "Auth");
      const toolsCount = toNumber(parseMarkdownField(markdown, "Tools"));
      const triggersCount = toNumber(parseMarkdownField(markdown, "Triggers"));
      const composioSlug = parseMarkdownField(markdown, "Slug").replace(/`/g, "").trim();
      const version = parseMarkdownField(markdown, "Version");
      const endpointUrls = extractEndpointUrls(markdown);
      const protocolHints = detectProtocolHints(markdown, slug, endpointUrls, toolsCount);

      const matchedApisGuru =
        apisGuruIndex.size > 0
          ? chooseApisGuruMatch(slug, name, composioSlug, apisGuruIndex)
          : null;

      const { openapiUrls, graphqlUrls } = extractUsableSpecUrls(markdown, matchedApisGuru);

      return {
        slug,
        docsUrl,
        toolkitUrl,
        name,
        category,
        auth,
        toolsCount,
        triggersCount,
        composioSlug,
        version,
        status: "ok",
        protocolHints,
        endpointUrls,
        usableOpenApiUrls: openapiUrls,
        usableGraphqlUrls: graphqlUrls,
        matchedApisGuru,
        error: "",
      };
    } catch (error) {
      return {
        slug,
        docsUrl,
        toolkitUrl,
        name: "",
        category: "",
        auth: "",
        toolsCount: 0,
        triggersCount: 0,
        composioSlug: "",
        version: "",
        status: "error",
        protocolHints: ["unknown"],
        endpointUrls: [],
        usableOpenApiUrls: [],
        usableGraphqlUrls: [],
        matchedApisGuru: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      completed += 1;
      if (completed % 25 === 0 || completed === targetSlugs.length) {
        console.log(`[composio] processed ${completed}/${targetSlugs.length}`);
      }
    }
  });

  const outDir = fileURLToPath(new URL("./data/", import.meta.url));
  await mkdir(outDir, { recursive: true });

  const jsonPath = fileURLToPath(new URL("./data/composio-toolkits-endpoints.json", import.meta.url));
  const csvPath = fileURLToPath(new URL("./data/composio-toolkits-endpoints.csv", import.meta.url));
  const summaryPath = fileURLToPath(new URL("./data/composio-toolkits-summary.json", import.meta.url));
  const needsResearchPath = fileURLToPath(new URL("./data/composio-toolkits-needs-research.csv", import.meta.url));
  const missingPath = fileURLToPath(new URL("./data/composio-toolkits-missing.txt", import.meta.url));

  const protocolCounts = records.reduce<Record<string, number>>((acc, row) => {
    for (const hint of row.protocolHints) {
      acc[hint] = (acc[hint] ?? 0) + 1;
    }
    return acc;
  }, {});

  const summary = {
    generatedAt: new Date().toISOString(),
    totalFromSitemap: allSlugs.length,
    processed: targetSlugs.length,
    ok: records.filter((row) => row.status === "ok").length,
    missing: records.filter((row) => row.status === "missing").length,
    error: records.filter((row) => row.status === "error").length,
    withEndpointUrls: records.filter((row) => row.endpointUrls.length > 0).length,
    withApisGuruMatch: records.filter((row) => row.matchedApisGuru !== null).length,
    withUsableOpenApi: records.filter((row) => row.usableOpenApiUrls.length > 0).length,
    withUsableGraphql: records.filter((row) => row.usableGraphqlUrls.length > 0).length,
    withAnyUsableSpec: records.filter((row) => row.usableOpenApiUrls.length > 0 || row.usableGraphqlUrls.length > 0).length,
    protocolCounts,
    args: {
      concurrency: defaultConcurrency,
      limit,
      only,
    },
  };

  const missingSlugs = records
    .filter((row) => row.status === "missing")
    .map((row) => row.slug)
    .sort((a, b) => a.localeCompare(b));

  await writeFile(jsonPath, `${JSON.stringify(records, null, 2)}\n`);
  await writeFile(csvPath, toCsv(records));
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(needsResearchPath, toNeedsResearchCsv(records));
  await writeFile(missingPath, `${missingSlugs.join("\n")}\n`);

  console.log("[composio] done");
  console.log(`[composio] json: ${jsonPath}`);
  console.log(`[composio] csv: ${csvPath}`);
  console.log(`[composio] summary: ${summaryPath}`);
  console.log(`[composio] needs-research: ${needsResearchPath}`);
  console.log(`[composio] missing-list: ${missingPath}`);
  console.log(
    `[composio] stats: ok=${summary.ok}, missing=${summary.missing}, error=${summary.error}, endpointUrls=${summary.withEndpointUrls}, apisGuruMatches=${summary.withApisGuruMatch}, usableOpenApi=${summary.withUsableOpenApi}, usableGraphql=${summary.withUsableGraphql}`,
  );
}

await main();
