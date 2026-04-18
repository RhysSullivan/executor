import { useState, type ReactNode } from "react";
import { SchemaExplorer } from "./schema-explorer";
import { ExpandableCodeBlock } from "./expandable-code-block";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { FilterTabs, type FilterTab } from "./filter-tabs";

export interface OperationDetailData {
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly inputTypeScript?: string | null;
  readonly outputTypeScript?: string | null;
  readonly definitions?: readonly { name: string; code: string }[];
}

type Tab = "schema" | "typescript" | "run";

function EmptySection(props: { title: string; message: string }) {
  return (
    <CardStack>
      <CardStackHeader>{props.title}</CardStackHeader>
      <CardStackContent>
        <p className="px-4 py-3 text-sm text-muted-foreground">{props.message}</p>
      </CardStackContent>
    </CardStack>
  );
}

export function OperationDetail({
  data,
  runPanel,
}: {
  data: OperationDetailData;
  runPanel?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("schema");

  const hasTypeScript = Boolean(data.inputTypeScript || data.outputTypeScript);
  const hasRun = Boolean(runPanel);

  const tabs: FilterTab<Tab>[] = [
    { label: "Schema", value: "schema" },
    ...(hasTypeScript ? [{ label: "TypeScript", value: "typescript" as const }] : []),
    ...(hasRun ? [{ label: "Run", value: "run" as const }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs<Tab> tabs={tabs} value={tab} onChange={setTab} />

      {tab === "run" && hasRun ? (
        runPanel
      ) : tab === "schema" ? (
        <div className="flex flex-col gap-4">
          {data.inputSchema !== undefined && data.inputSchema !== null ? (
            <SchemaExplorer schema={data.inputSchema} title="Parameters" />
          ) : (
            <EmptySection title="Parameters" message="None" />
          )}
          {data.outputSchema !== undefined && data.outputSchema !== null ? (
            <SchemaExplorer schema={data.outputSchema} title="Response" />
          ) : (
            <EmptySection title="Response" message="None" />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {data.inputTypeScript ? (
            <CardStack>
              <CardStackHeader>Input</CardStackHeader>
              <CardStackContent>
                <ExpandableCodeBlock
                  code={data.inputTypeScript}
                  definitions={data.definitions}
                  className="rounded-none border-0"
                />
              </CardStackContent>
            </CardStack>
          ) : (
            <EmptySection title="Input" message="void" />
          )}
          {data.outputTypeScript ? (
            <CardStack>
              <CardStackHeader>Output</CardStackHeader>
              <CardStackContent>
                <ExpandableCodeBlock
                  code={data.outputTypeScript}
                  definitions={data.definitions}
                  className="rounded-none border-0"
                />
              </CardStackContent>
            </CardStack>
          ) : (
            <EmptySection title="Output" message="void" />
          )}
        </div>
      )}
    </div>
  );
}
