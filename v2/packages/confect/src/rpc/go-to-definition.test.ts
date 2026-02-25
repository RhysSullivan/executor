import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");

const confectConfigPath = path.join(packageRoot, "tsconfig.json");
const configFile = ts.readConfigFile(confectConfigPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(
	configFile.config,
	ts.sys,
	path.dirname(confectConfigPath),
);

const testFile = path.join(packageRoot, "src/rpc/client.test.ts");

const program = ts.createProgram({
	rootNames: [testFile],
	options: parsedConfig.options,
});

const checker = program.getTypeChecker();
const sf = program.getSourceFile(testFile);

function findNodeAtPosition(
	node: ts.Node,
	position: number,
): ts.Node | undefined {
	if (position >= node.getStart() && position < node.getEnd()) {
		for (const child of node.getChildren()) {
			const found = findNodeAtPosition(child, position);
			if (found) return found;
		}
		return node;
	}
	return undefined;
}

function hasDeclarations(pattern: string, offset: number): boolean {
	if (!sf) return false;

	const content = sf.getFullText();
	const idx = content.indexOf(pattern);
	if (idx === -1) return false;

	const pos = idx + offset;
	const node = findNodeAtPosition(sf, pos);
	if (!node) return false;

	const sym = checker.getSymbolAtLocation(node);
	if (!sym) return false;

	const decls = sym.getDeclarations();
	return decls !== undefined && decls.length > 0;
}

describe("Go-to-Definition", () => {
	it("should load the test file", () => {
		expect(sf).toBeDefined();
	});

	describe("module endpoints", () => {
		it("guestbookModule.add has declarations", () => {
			expect(hasDeclarations("guestbookModule.add", "guestbookModule.".length)).toBe(true);
		});

		it("guestbookModule.list has declarations", () => {
			expect(hasDeclarations("guestbookModule.list", "guestbookModule.".length)).toBe(true);
		});

		it("guestbookModule.get has declarations", () => {
			expect(hasDeclarations("guestbookModule.get", "guestbookModule.".length)).toBe(true);
		});
	});

	describe("client endpoints", () => {
		it("client.add has declarations", () => {
			expect(hasDeclarations("client.add", "client.".length)).toBe(true);
		});

		it("client.list has declarations", () => {
			expect(hasDeclarations("client.list", "client.".length)).toBe(true);
		});
	});
});
