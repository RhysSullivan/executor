export function runtimeDoctorScript(): string {
  return "~/.executor/bin/executor doctor --runtime-only --verbose";
}

export function anonymousBootstrapCheckScript(ports: { backendPort: number; webPort: number }): string {
  return [
    "set -euo pipefail",
    "for candidate in ~/.executor/runtime/node-*/bin/node; do node_bin=\"$candidate\"; break; done",
    "if [ -z \"${node_bin:-}\" ]; then echo 'node runtime missing' >&2; exit 1; fi",
    `token_json=$(curl -fsS -X POST http://127.0.0.1:${ports.webPort}/api/auth/anonymous-token -H 'content-type: application/json' -d '{}')`,
    "access_token=$(printf '%s' \"$token_json\" | \"$node_bin\" -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);if(typeof j.accessToken!=='string'||j.accessToken.length===0){console.error(d);process.exit(2)}process.stdout.write(j.accessToken)})\")",
    `mutation_json=$(curl -fsS -X POST http://127.0.0.1:${ports.backendPort}/api/mutation -H 'content-type: application/json' -H \"authorization: Bearer $access_token\" -d '{\"path\":\"workspace:bootstrapAnonymousSession\",\"args\":{}}')`,
    "printf '%s' \"$mutation_json\" | \"$node_bin\" -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);if(j.status!=='success' || !j.value || typeof j.value.workspaceId!=='string' || typeof j.value.sessionId!=='string'){console.error(d);process.exit(3)}console.log(JSON.stringify({workspaceId:j.value.workspaceId,sessionId:j.value.sessionId}))})\"",
  ].join("; ");
}
