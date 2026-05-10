import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const marketingWorker = (appDir: string, images: Cloudflare.Images) =>
  Cloudflare.StaticSite("Marketing", {
    name: "executor-marketing",
    cwd: appDir,
    command: "bun run build",
    outdir: "dist",
    main: `${appDir}/src/worker.ts`,
    compatibility: {
      date: "2026-04-22",
      flags: ["nodejs_compat"],
    },
    memo: {
      include: [
        "alchemy.run.ts",
        "astro.config.mjs",
        "package.json",
        "public/**",
        "src/**",
        "tsconfig.json",
        "../../package.json",
        "../../bun.lock",
        "../../packages/**/package.json",
        "../../packages/**/src/**",
      ],
    },
    assetsConfig: {
      runWorkerFirst: true,
    },
    env: {
      PUBLIC_POSTHOG_KEY: "phc_nNLrNMALpRsfrEkZovUkfMxYbcJvHnsJHeoSPavprgLL",
    },
    bindings: {
      IMAGES: images,
    },
  });

export const marketingStack = (appDir: string) =>
  Effect.gen(function* () {
    const images = yield* Cloudflare.Images();

    const worker = yield* marketingWorker(appDir, images);

    return {
      workerName: worker.workerName,
      url: worker.url,
    };
  });
