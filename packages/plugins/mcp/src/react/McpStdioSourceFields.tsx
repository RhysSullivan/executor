import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";
import { Textarea } from "@executor-js/react/components/textarea";

export function McpStdioSourceFields(props: {
  readonly command: string;
  readonly onCommandChange: (value: string) => void;
  readonly args: string;
  readonly onArgsChange: (value: string) => void;
  readonly env: string;
  readonly onEnvChange: (value: string) => void;
  readonly cwd?: string;
  readonly onCwdChange?: (value: string) => void;
}) {
  const showCwd = props.onCwdChange !== undefined;
  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <CardStackEntryField
          label="Command"
          description="- The executable to run (e.g. npx, uvx, node)."
        >
          <Input
            value={props.command}
            onChange={(e) => props.onCommandChange((e.target as HTMLInputElement).value)}
            placeholder="npx"
            className="font-mono text-sm"
          />
        </CardStackEntryField>

        <CardStackEntryField
          label="Arguments"
          description="- Space-separated arguments passed to the command."
        >
          <Input
            value={props.args}
            onChange={(e) => props.onArgsChange((e.target as HTMLInputElement).value)}
            placeholder="-y chrome-devtools-mcp@latest"
            className="font-mono text-sm"
          />
        </CardStackEntryField>

        <CardStackEntryField
          label="Environment variables"
          description="- One per line, KEY=value format."
        >
          <Textarea
            value={props.env}
            onChange={(e) => props.onEnvChange((e.target as HTMLTextAreaElement).value)}
            placeholder={"KEY=value\nANOTHER=value"}
            rows={3}
            maxRows={10}
            className="font-mono text-sm"
          />
        </CardStackEntryField>

        {showCwd && (
          <CardStackEntryField
            label="Working directory"
            description="- Optional. Absolute path the command runs in."
          >
            <Input
              value={props.cwd ?? ""}
              onChange={(e) => props.onCwdChange?.((e.target as HTMLInputElement).value)}
              placeholder="/path/to/dir"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        )}
      </CardStackContent>
    </CardStack>
  );
}
