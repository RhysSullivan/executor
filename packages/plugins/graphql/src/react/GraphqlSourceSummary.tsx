import type { ScopeId } from "@executor/sdk";

export default function GraphqlSourceSummary(props: {
  sourceId: string;
  sourceScopeId?: ScopeId;
}) {
  return <span>GraphQL · {props.sourceId}</span>;
}
