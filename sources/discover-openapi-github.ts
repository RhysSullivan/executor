interface CodeSearchRepo {
  full_name: string;
  html_url: string;
  default_branch?: string;
  stargazers_count?: number;
}

interface RepoDetailsResponse {
  stargazers_count?: number;
  default_branch?: string;
}

interface CodeSearchItem {
  path: string;
  html_url: string;
  repository: CodeSearchRepo;
}

interface CodeSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: CodeSearchItem[];
}

interface SearchRequestOptions {
  token: string;
  query: string;
  page: number;
  perPage: number;
  maxRetries: number;
}

interface DiscoveredSpec {
  repo: string;
  repoUrl: string;
  stars: number;
  path: string;
  rawUrl: string;
  versionHint: string;
  query: string;
}

interface SearchQuery {
  query: string;
  versionHint: string;
}

const SEARCH_QUERIES: SearchQuery[] = [
  { query: 'filename:openapi.yaml "openapi: 3"', versionHint: "openapi-3" },
  { query: 'filename:openapi.yml "openapi: 3"', versionHint: "openapi-3" },
  { query: "filename:openapi.json openapi", versionHint: "openapi-3" },
  { query: 'path:/openapi/ extension:yaml "openapi: 3"', versionHint: "openapi-3" },
  { query: 'path:/openapi/ extension:yml "openapi: 3"', versionHint: "openapi-3" },
  { query: "filename:swagger.json swagger", versionHint: "swagger-2.0" },
  { query: 'filename:swagger.yaml "swagger: 2.0"', versionHint: "swagger-2.0" },
  { query: 'filename:swagger.yml "swagger: 2.0"', versionHint: "swagger-2.0" },
];

const SKIP_REPOS =
  /(openapi-generator|swagger-editor|swagger-ui|openapi-typescript|openapi-cli|spectral|kin-openapi|swagger-parser|openapi-core|openapi-diff|drf-yasg|swashbuckle|springdoc-openapi|oasdiff|openapi-go|openapi-rs|openapi-python-client|openapi-kit|openapi-dotnet|openapi-php|openapi-node|openapi-lint|openapi-validator|openapi-editor|openapi-examples)/i;

const SKIP_PATH_SEGMENTS = /(\/|^)(test|tests|example|examples|fixture|fixtures|mock|mocks|sample|samples|vendor)(\/|$)/i;
const ALLOWED_SPEC_PATH = /\.(yaml|yml|json)$/i;
const SKIP_PATH_SUFFIX = /\.(template|mustache|twig|plush)$/i;

function parseArgNumber(argv: string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parseArgString(argv: string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = argv[index + 1]?.trim();
  return value ? value : fallback;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

async function resolveGitHubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN?.trim()) {
    return process.env.GITHUB_TOKEN.trim();
  }

  try {
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const token = out.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function githubCodeSearch(options: SearchRequestOptions): Promise<CodeSearchResponse | null> {
  const { token, query, page, perPage, maxRetries } = options;
  const url = new URL("https://api.github.com/search/code");
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "opencode-openapi-discovery",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.ok) {
      return (await response.json()) as CodeSearchResponse;
    }

    const text = await response.text();

    if (response.status === 403 && attempt < maxRetries) {
      const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? "0");
      const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? "0");

      if (remaining === 0 && Number.isFinite(resetAt) && resetAt > 0) {
        const waitMs = Math.max(1_000, resetAt * 1000 - Date.now() + 2_000);
        const waitSec = Math.ceil(waitMs / 1000);
        console.log(`code_search rate limited; waiting ${waitSec}s before retry`);
        await Bun.sleep(waitMs);
        continue;
      }
    }

    console.error(`search failed (${response.status}) for query: ${query}`);
    console.error(text.slice(0, 300));
    return null;
  }

  return null;
}

function inferDefaultBranchFromHtml(htmlUrl: string, path: string): string {
  const marker = "/blob/";
  const idx = htmlUrl.indexOf(marker);
  if (idx < 0) return "main";
  const rest = htmlUrl.slice(idx + marker.length);
  const pathIndex = rest.indexOf(`/${path}`);
  if (pathIndex < 0) return "main";
  return rest.slice(0, pathIndex);
}

function toCsvRow(values: string[]): string {
  return values
    .map((value) => `"${value.replace(/"/g, '""')}"`)
    .join(",");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function fetchRepoDetails(
  token: string,
  repo: string,
): Promise<{ stars: number; defaultBranch: string | null }> {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      "User-Agent": "opencode-openapi-discovery",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return { stars: 0, defaultBranch: null };
  }

  const data = (await response.json()) as RepoDetailsResponse;
  return {
    stars: data.stargazers_count ?? 0,
    defaultBranch: data.default_branch ?? null,
  };
}

async function main(): Promise<void> {
  const token = await resolveGitHubToken();
  if (!token) {
    console.error("Missing GitHub token. Set GITHUB_TOKEN or run `gh auth login`.");
    process.exitCode = 1;
    return;
  }

  const maxPagesPerQuery = parseArgNumber(process.argv, "--pages", 3);
  const perPage = Math.min(100, parseArgNumber(process.argv, "--per-page", 100));
  const delayMs = parseArgNumber(process.argv, "--delay-ms", 500);
  const maxSearchRetries = parseArgNumber(process.argv, "--search-retries", 5);
  const starConcurrency = parseArgNumber(process.argv, "--star-concurrency", 20);
  const minStars = parseArgNumber(process.argv, "--min-stars", 0);
  const skipRepoDetails = hasFlag(process.argv, "--skip-repo-details");
  const outputBase = parseArgString(
    process.argv,
    "--output",
    "./data/openapi-github-discovery",
  );

  const discovered = new Map<string, DiscoveredSpec>();
  const queryStats: Array<{ query: string; totalCount: number; pagesFetched: number }> = [];

  for (const search of SEARCH_QUERIES) {
    let totalCount = 0;
    let pagesFetched = 0;

    for (let page = 1; page <= maxPagesPerQuery; page += 1) {
      console.log(`searching: ${search.query} (page ${page}/${maxPagesPerQuery})`);

      const result = await githubCodeSearch({
        token,
        query: search.query,
        page,
        perPage,
        maxRetries: maxSearchRetries,
      });

      if (!result) break;

      totalCount = result.total_count;
      pagesFetched = page;

      for (const item of result.items) {
        const repo = item.repository;
        if (SKIP_REPOS.test(repo.full_name)) continue;
        if (SKIP_PATH_SEGMENTS.test(item.path)) continue;
        if (!ALLOWED_SPEC_PATH.test(item.path)) continue;
        if (SKIP_PATH_SUFFIX.test(item.path)) continue;

        const defaultBranch = repo.default_branch || inferDefaultBranchFromHtml(item.html_url, item.path);
        const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${defaultBranch}/${item.path}`;
        const dedupeKey = `${repo.full_name}:${item.path}`;

        if (!discovered.has(dedupeKey)) {
          discovered.set(dedupeKey, {
            repo: repo.full_name,
            repoUrl: repo.html_url,
            stars: repo.stargazers_count ?? 0,
            path: item.path,
            rawUrl,
            versionHint: search.versionHint,
            query: search.query,
          });
        }
      }

      if (result.items.length < perPage) break;

      if (delayMs > 0) {
        await Bun.sleep(delayMs);
      }
    }

    queryStats.push({ query: search.query, totalCount, pagesFetched });
  }

  const items = [...discovered.values()].sort(
    (a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path),
  );

  if (!skipRepoDetails) {
    const uniqueRepos = [...new Set(items.map((item) => item.repo))];
    const detailsPairs = await mapWithConcurrency(uniqueRepos, starConcurrency, async (repo) => {
      const details = await fetchRepoDetails(token, repo);
      return { repo, ...details };
    });

    const detailsByRepo = new Map(detailsPairs.map((pair) => [pair.repo, pair]));

    for (const item of items) {
      const details = detailsByRepo.get(item.repo);
      item.stars = details?.stars ?? 0;
      if (details?.defaultBranch) {
        item.rawUrl = `https://raw.githubusercontent.com/${item.repo}/${details.defaultBranch}/${item.path}`;
      }
    }
  }

  const filteredItems = items
    .filter((item) => item.stars >= minStars)
    .sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));

  const output = {
    generatedAt: new Date().toISOString(),
    maxPagesPerQuery,
    perPage,
    searchQueries: SEARCH_QUERIES,
    queryStats,
    totalDiscoveredSpecs: filteredItems.length,
    items: filteredItems,
  };

  const jsonPath = `${outputBase}.json`;
  const csvPath = `${outputBase}.csv`;

  const csvRows = [
    toCsvRow(["repo", "repo_url", "stars", "path", "raw_url", "version_hint", "matched_query"]),
    ...filteredItems.map((item) =>
      toCsvRow([
        item.repo,
        item.repoUrl,
        String(item.stars),
        item.path,
        item.rawUrl,
        item.versionHint,
        item.query,
      ]),
    ),
  ];

  await Bun.write(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  await Bun.write(csvPath, `${csvRows.join("\n")}\n`);

  console.log(`queries: ${SEARCH_QUERIES.length}`);
  console.log(`discovered specs: ${filteredItems.length}`);
  console.log(`wrote: ${jsonPath}`);
  console.log(`wrote: ${csvPath}`);
}

void main();
