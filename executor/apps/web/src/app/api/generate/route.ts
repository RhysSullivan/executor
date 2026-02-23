import { z } from "zod";
import { prepareOpenApiSpec } from "@executor/core/openapi-prepare";

const requestSchema = z.object({
  specUrl: z.string().trim().min(1),
  sourceName: z.string().trim().min(1),
  includeDts: z.boolean().optional(),
});

function noStoreJson(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return noStoreJson({ error: "Invalid generate request" }, 400);
  }

  try {
    const prepared = await prepareOpenApiSpec(
      parsed.data.specUrl,
      parsed.data.sourceName,
      {
        includeDts: parsed.data.includeDts ?? false,
        profile: "inventory",
      },
    );

    return noStoreJson({
      status: "ready",
      prepared,
    }, 200);
  } catch (error) {
    return noStoreJson({
      status: "failed",
      error: error instanceof Error ? error.message : "Failed to generate",
    }, 502);
  }
}
