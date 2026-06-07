import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { IntegrationSlug, type Connection } from "@executor-js/sdk/shared";
import {
  decodeGraphqlIntegrationConfigOption,
  type AuthTemplate,
  type GraphqlIntegrationConfig,
} from "@executor-js/plugin-graphql";
import { connectionsAllAtom } from "@executor-js/react/api/atoms";
import { IntegrationCredentialNotice } from "@executor-js/react/plugins/integration-credential-status";

import { graphqlIntegrationConfigAtom } from "./atoms";

// Labels of the integration's auth templates that have no connection for any
// owner. v2 has no scope-stack binding resolution: a connection IS the
// credential, so "missing" is simply "no connection for this template".
const missingTemplateLabels = (
  config: GraphqlIntegrationConfig,
  connections: readonly Connection[],
): readonly string[] => {
  const templatesWithConnection = new Set(
    connections.map((connection) => String(connection.template)),
  );
  return config.authenticationTemplate
    .filter((template: AuthTemplate) => !templatesWithConnection.has(template.slug))
    .map((template: AuthTemplate) =>
      template.kind === "oauth2" ? "OAuth sign-in" : `API key (${template.slug})`,
    );
};

export default function GraphqlSourceSummary(props: {
  sourceId: string;
  variant?: "badge" | "panel";
  onAction?: () => void;
}) {
  const slug = IntegrationSlug.make(props.sourceId);
  const configResult = useAtomValue(graphqlIntegrationConfigAtom(slug));
  // Connections across BOTH owners (omit-owner read); "missing" is "no
  // connection under either owner for this template".
  const connectionsResult = useAtomValue(connectionsAllAtom);

  const config = AsyncResult.isSuccess(configResult)
    ? Option.getOrNull(decodeGraphqlIntegrationConfigOption(configResult.value))
    : null;

  const connections = useMemo<readonly Connection[]>(() => {
    const all = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
    return all.filter((connection: Connection) => connection.integration === slug);
  }, [connectionsResult, slug]);

  if (!config || config.authenticationTemplate.length === 0) return null;

  if (props.variant !== "panel") return null;
  if (!AsyncResult.isSuccess(configResult) || !AsyncResult.isSuccess(connectionsResult)) {
    return null;
  }

  const missing = missingTemplateLabels(config, connections);

  return <IntegrationCredentialNotice missing={missing} onAction={props.onAction} />;
}
