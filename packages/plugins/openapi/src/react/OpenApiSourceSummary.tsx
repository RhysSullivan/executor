import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAllAtom } from "@executor-js/react/api/atoms";
import { IntegrationSlug, type Connection } from "@executor-js/sdk/shared";
import { IntegrationCredentialNotice } from "@executor-js/react/plugins/integration-credential-status";

// ---------------------------------------------------------------------------
// v2 summary — a connection IS the credential, so "configured" means the
// integration has at least one connection under EITHER owner. The entry row
// already renders name + slug + kind; this only contributes a panel notice
// derived from whether any connection exists (both owners merged — the global
// owner toggle is retired). The non-panel status badge is retired.
//
// The v1 per-source credential-slot resolution (header/oauth/secret slots,
// scope-stack binding lookup) is gone: there are no slots and no bindings in
// v2, just connections.
// ---------------------------------------------------------------------------

export default function OpenApiSourceSummary(props: {
  sourceId: string;
  variant?: "badge" | "panel";
  onAction?: () => void;
}) {
  const slug = IntegrationSlug.make(props.sourceId);
  const connectionsResult = useAtomValue(connectionsAllAtom);

  if (props.variant !== "panel") return null;
  if (!AsyncResult.isSuccess(connectionsResult)) return null;

  const connection = connectionsResult.value.find(
    (candidate: Connection) => candidate.integration === slug,
  );
  const missing = connection ? [] : ["a connection"];

  return missing.length > 0 ? (
    <IntegrationCredentialNotice missing={missing} onAction={props.onAction} />
  ) : null;
}
