import { useCallback, useMemo } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";

import { AccountsSection } from "@executor-js/react/components/accounts-section";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import type { CreateCustomMethod } from "@executor-js/react/components/add-custom-method-modal";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";

import { graphqlConfigAtom, graphqlConfigure } from "./atoms";
import { authMethodsFromConfig, graphqlTemplatesFromPlacements } from "./auth-method-config";
import type { AuthTemplate } from "../sdk/types";

// ---------------------------------------------------------------------------
// GraphQL Accounts hub — fills the generic detail page's `accounts` slot.
//
// Reads the integration's real `authenticationTemplate` (via `getConfig`),
// converts it to generic `AuthMethod[]`, and composes the generic
// `AccountsSection` — whose Add-account offers those methods plus a "+ Custom
// method" row (apiKey-only). The custom-method create is INJECTED here
// (`createCustomMethod`): generic placements → graphql `apiKey` templates
// (`graphqlTemplatesFromPlacements`, slug omitted → backend `custom_<id>`)
// merge-appended via `configure`. Stays plugin-side because it touches the
// graphql sdk `AuthTemplate` types.
// ---------------------------------------------------------------------------

export default function GraphqlAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
  readonly accountHandoff?: IntegrationAccountHandoff | null;
}) {
  const { sourceId, integrationName, accountHandoff } = props;
  const slug = IntegrationSlug.make(sourceId);
  const configResult = useAtomValue(graphqlConfigAtom(slug));
  const doConfigure = useAtomSet(graphqlConfigure, { mode: "promiseExit" });

  const existingTemplate = useMemo<readonly AuthTemplate[]>(() => {
    if (!AsyncResult.isSuccess(configResult) || configResult.value == null) return [];
    return configResult.value.authenticationTemplate ?? [];
  }, [configResult]);

  const methods = useMemo<readonly AuthMethod[]>(
    () => authMethodsFromConfig(existingTemplate),
    [existingTemplate],
  );

  // Add a custom apiKey method: build graphql `apiKey` templates from the
  // generic placements (slug omitted → backend backfills `custom_<id>`),
  // merge-append (the configure endpoint merges) and persist. Returns the
  // created `AuthMethod` so Add-account can select it immediately.
  const createCustomMethod = useCallback<CreateCustomMethod>(
    async (input: { readonly label: string; readonly placements: readonly Placement[] }) => {
      const templates = graphqlTemplatesFromPlacements(input.placements, "");
      if (templates.length === 0) return null;
      const exit = await doConfigure({
        params: { slug: String(slug) },
        payload: { authenticationTemplate: templates },
        reactivityKeys: integrationWriteKeys,
      });
      if (Exit.isFailure(exit)) return null;
      const created = authMethodsFromConfig(templates)[0];
      return created ?? null;
    },
    [doConfigure, slug],
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <AccountsSection
        integration={slug}
        integrationName={integrationName}
        methods={methods}
        accountHandoff={accountHandoff}
        createCustomMethod={createCustomMethod}
      />
    </div>
  );
}
