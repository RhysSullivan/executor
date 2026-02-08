import { loadExternalTools } from "./tool-sources";
import type { ExternalToolSourceConfig } from "./tool-sources";

const sources: ExternalToolSourceConfig[] = [
  {
    type: "openapi",
    name: "stripe",
    spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    baseUrl: "https://api.stripe.com",
  },
];

async function measure() {
  console.log("Loading all sources concurrently...\n");
  const start = performance.now();

  // Load each source individually so we can measure per-source
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const t0 = performance.now();
      const { tools, warnings } = await loadExternalTools([source]);
      const elapsed = performance.now() - t0;

      // Build the ToolDescriptor[] (same shape the frontend gets)
      const descriptors = tools.map((t) => ({
        path: t.path,
        description: t.description,
        approval: t.approval,
        source: t.source,
        argsType: t.metadata?.argsType,
        returnsType: t.metadata?.returnsType,
      }));

      const json = JSON.stringify(descriptors);
      return {
        name: source.name,
        toolCount: tools.length,
        jsonBytes: json.length,
        elapsed,
        warnings,
      };
    }),
  );

  const totalElapsed = performance.now() - start;

  console.log("Source               | Tools | JSON size     | Time     | Warnings");
  console.log("---------------------|-------|---------------|----------|----------");

  let totalTools = 0;
  let totalBytes = 0;

  for (const r of results) {
    if (r.status === "fulfilled") {
      const { name, toolCount, jsonBytes, elapsed, warnings } = r.value;
      totalTools += toolCount;
      totalBytes += jsonBytes;
      const sizeStr = jsonBytes > 1024 * 1024
        ? `${(jsonBytes / 1024 / 1024).toFixed(1)} MB`
        : jsonBytes > 1024
          ? `${(jsonBytes / 1024).toFixed(1)} KB`
          : `${jsonBytes} B`;
      console.log(
        `${name.padEnd(20)} | ${String(toolCount).padStart(5)} | ${sizeStr.padStart(13)} | ${(elapsed / 1000).toFixed(1)}s`.padEnd(60) +
        `| ${warnings.length > 0 ? warnings.join("; ") : "ok"}`,
      );
    } else {
      const source = sources[results.indexOf(r)]!;
      console.log(
        `${source.name.padEnd(20)} | FAILED: ${r.reason instanceof Error ? r.reason.message.slice(0, 60) : String(r.reason).slice(0, 60)}`,
      );
    }
  }

  const totalSizeStr = totalBytes > 1024 * 1024
    ? `${(totalBytes / 1024 / 1024).toFixed(1)} MB`
    : `${(totalBytes / 1024).toFixed(1)} KB`;

  console.log("---------------------|-------|---------------|----------|----------");
  console.log(`TOTAL                | ${String(totalTools).padStart(5)} | ${totalSizeStr.padStart(13)} | ${(totalElapsed / 1000).toFixed(1)}s`);
  console.log(`\nAvg descriptor size: ${totalTools > 0 ? Math.round(totalBytes / totalTools) : 0} bytes/tool`);
}

measure().catch(console.error);
