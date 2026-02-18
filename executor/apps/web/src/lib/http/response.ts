export function noStoreJson(payload: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(headers ?? {}),
    },
  });
}

export function redirectResponse(url: string, status = 302, headers?: HeadersInit): Response {
  return new Response(null, {
    status,
    headers: {
      Location: url,
      ...(headers ?? {}),
    },
  });
}
