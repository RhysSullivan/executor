interface DiscoveredSpec {
  repo: string;
  repoUrl: string;
  stars: number;
  path: string;
  rawUrl: string;
  versionHint: string;
  query: string;
}

interface DiscoveryFile {
  generatedAt: string;
  totalDiscoveredSpecs: number;
  items: DiscoveredSpec[];
}

interface RepoDetailsResponse {
  stargazers_count?: number;
  default_branch?: string;
}

function parseArgNumber(argv: string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function parseArgString(argv: string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = argv[index + 1]?.trim();
  return value ? value : fallback;
}

async function resolveGitHubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();

  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const token = out.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
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
): Promise<{ repo: string; stars: number; defaultBranch: string | null }> {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      "User-Agent": "opencode-openapi-enricher",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return { repo, stars: 0, defaultBranch: null };
  }

  const data = (await response.json()) as RepoDetailsResponse;
  return {
    repo,
    stars: data.stargazers_count ?? 0,
    defaultBranch: data.default_branch ?? null,
  };
}

function toCsvRow(values: string[]): string {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(",");
}

async function main(): Promise<void> {
  const token = await resolveGitHubToken();
  if (!token) {
    console.error("Missing GitHub token. Set GITHUB_TOKEN or run `gh auth login`.");
    process.exitCode = 1;
    return;
  }

  const inputPath = parseArgString(
    process.argv,
    "--input",
    "./data/openapi-github-discovery-huge.json",
  );
  const outputBase = parseArgString(
    process.argv,
    "--output",
    "./data/openapi-github-discovery-huge-enriched",
  );
  const minStars = parseArgNumber(process.argv, "--min-stars", 0);
  const concurrency = parseArgNumber(process.argv, "--concurrency", 30);

  const input = (await Bun.file(inputPath).json()) as DiscoveryFile;
  const items: DiscoveredSpec[] = input.items.map((item) => ({ ...item }));
  const uniqueRepos = [...new Set(items.map((item) => item.repo))];

  console.log(`input specs: ${items.length}`);
  console.log(`unique repos: ${uniqueRepos.length}`);

  const details = await mapWithConcurrency(uniqueRepos, concurrency, async (repo) => {
    return await fetchRepoDetails(token, repo);
  });

  const detailsByRepo = new Map(details.map((detail) => [detail.repo, detail]));

  for (const item of items) {
    const detail = detailsByRepo.get(item.repo);
    if (!detail) continue;
    item.stars = detail.stars;
    if (detail.defaultBranch) {
      item.rawUrl = `https://raw.githubusercontent.com/${item.repo}/${detail.defaultBranch}/${item.path}`;
    }
  }

  const filteredItems = items
    .filter((item) => item.stars >= minStars)
    .sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));

  const output = {
    ...input,
    enrichedAt: new Date().toISOString(),
    minStars,
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

  console.log(`enriched specs: ${filteredItems.length}`);
  console.log(`wrote: ${jsonPath}`);
  console.log(`wrote: ${csvPath}`);
}

void main();
