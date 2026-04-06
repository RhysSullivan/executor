import type { APIRoute } from 'astro'

export const prerender = false

interface DetectedTool {
  name: string
  desc: string
  method: string
  policy: 'read' | 'write' | 'destructive'
}

interface DetectionResult {
  kind: 'openapi' | 'graphql' | 'mcp' | 'googleDiscovery'
  name: string
  count: number
  tools: DetectedTool[]
}

function policyFromMethod(method: string): 'read' | 'write' | 'destructive' {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || m === 'QUERY') return 'read'
  if (m === 'DELETE') return 'destructive'
  return 'write'
}

async function tryOpenAPI(url: string, signal: AbortSignal): Promise<DetectionResult | null> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json, application/yaml, text/yaml, */*' } })
    if (!res.ok) return null
    const text = await res.text()
    let doc: any
    try {
      doc = JSON.parse(text)
    } catch {
      // Could be YAML - check for openapi/swagger string markers
      if (text.includes('openapi:') || text.includes('swagger:')) {
        // Basic YAML detection - we can't fully parse YAML without a dep,
        // but we can confirm it's an OpenAPI spec
        return {
          kind: 'openapi',
          name: 'API',
          count: 0,
          tools: [{ name: 'spec.detected', desc: 'OpenAPI spec detected (YAML)', method: 'GET', policy: 'read' }],
        }
      }
      return null
    }

    // Check for OpenAPI 3.x or Swagger 2.x
    if (!doc.openapi && !doc.swagger) return null

    const title = doc.info?.title || 'API'
    const tools: DetectedTool[] = []

    if (doc.paths) {
      for (const [path, methods] of Object.entries(doc.paths as Record<string, any>)) {
        for (const method of ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']) {
          const op = methods[method]
          if (!op) continue
          const opId = op.operationId || `${method}.${path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`
          tools.push({
            name: opId,
            desc: op.summary || op.description?.slice(0, 80) || `${method.toUpperCase()} ${path}`,
            method: method.toUpperCase(),
            policy: policyFromMethod(method),
          })
        }
      }
    }

    return {
      kind: 'openapi',
      name: title,
      count: tools.length,
      tools: tools.slice(0, 12),
    }
  } catch {
    return null
  }
}

async function tryGraphQL(url: string, signal: AbortSignal): Promise<DetectionResult | null> {
  try {
    const introspectionQuery = `{
      __schema {
        queryType { name }
        mutationType { name }
        types {
          kind name
          fields(includeDeprecated: false) { name description }
        }
      }
    }`

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: introspectionQuery }),
    })
    if (!res.ok) return null
    const json = await res.json() as any

    const schema = json.data?.__schema || json.__schema
    if (!schema) return null

    const tools: DetectedTool[] = []
    const queryTypeName = schema.queryType?.name || 'Query'
    const mutationTypeName = schema.mutationType?.name || 'Mutation'

    for (const type of schema.types || []) {
      if (type.name === queryTypeName && type.fields) {
        for (const field of type.fields) {
          if (field.name.startsWith('__')) continue
          tools.push({
            name: field.name,
            desc: field.description?.slice(0, 80) || `Query ${field.name}`,
            method: 'query',
            policy: 'read',
          })
        }
      }
      if (type.name === mutationTypeName && type.fields) {
        for (const field of type.fields) {
          if (field.name.startsWith('__')) continue
          const isDestructive = /delete|remove|destroy/i.test(field.name)
          tools.push({
            name: field.name,
            desc: field.description?.slice(0, 80) || `Mutation ${field.name}`,
            method: 'mutation',
            policy: isDestructive ? 'destructive' : 'write',
          })
        }
      }
    }

    // Derive name from URL hostname
    const hostname = new URL(url).hostname.replace('api.', '').split('.')[0]
    const name = hostname.charAt(0).toUpperCase() + hostname.slice(1)

    return {
      kind: 'graphql',
      name: name || 'GraphQL API',
      count: tools.length,
      tools: tools.slice(0, 12),
    }
  } catch {
    return null
  }
}

async function tryGoogleDiscovery(url: string, signal: AbortSignal): Promise<DetectionResult | null> {
  try {
    // Only probe URLs that look like Google Discovery docs
    if (!url.includes('googleapis.com') && !url.includes('/discovery/')) return null

    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const doc = await res.json() as any

    if (!doc.discoveryVersion && !doc.kind?.includes('discovery')) return null

    const title = doc.title || doc.name || 'Google API'
    const tools: DetectedTool[] = []

    function extractMethods(resources: any, prefix = '') {
      if (!resources) return
      for (const [resourceName, resource] of Object.entries(resources as Record<string, any>)) {
        if (resource.methods) {
          for (const [methodName, method] of Object.entries(resource.methods as Record<string, any>)) {
            const httpMethod = (method.httpMethod || 'GET').toUpperCase()
            tools.push({
              name: `${prefix}${resourceName}.${methodName}`,
              desc: method.description?.slice(0, 80) || `${httpMethod} ${method.path || ''}`,
              method: httpMethod,
              policy: policyFromMethod(httpMethod),
            })
          }
        }
        if (resource.resources) {
          extractMethods(resource.resources, `${prefix}${resourceName}.`)
        }
      }
    }

    extractMethods(doc.resources)

    // Also check top-level methods
    if (doc.methods) {
      for (const [methodName, method] of Object.entries(doc.methods as Record<string, any>)) {
        const httpMethod = (method.httpMethod || 'GET').toUpperCase()
        tools.push({
          name: methodName,
          desc: method.description?.slice(0, 80) || `${httpMethod} ${method.path || ''}`,
          method: httpMethod,
          policy: policyFromMethod(httpMethod),
        })
      }
    }

    return {
      kind: 'googleDiscovery',
      name: title,
      count: tools.length,
      tools: tools.slice(0, 12),
    }
  } catch {
    return null
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as { url?: string }
    const url = body.url?.trim()
    if (!url) {
      return new Response(JSON.stringify({ error: 'URL is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    // Validate URL
    try {
      new URL(url)
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    // Run all detectors in parallel
    const [openapi, graphql, google] = await Promise.all([
      tryOpenAPI(url, controller.signal),
      tryGraphQL(url, controller.signal),
      tryGoogleDiscovery(url, controller.signal),
    ])

    clearTimeout(timeout)

    // Return first successful detection (prefer by confidence: most tools wins)
    const results = [openapi, graphql, google].filter((r): r is DetectionResult => r !== null)
    results.sort((a, b) => b.count - a.count)

    if (results.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Could not detect an API at this URL. Try an OpenAPI spec, GraphQL endpoint, or Google Discovery document.' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    return new Response(JSON.stringify(results[0]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Detection failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
