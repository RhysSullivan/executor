export function raise(error: unknown): never {
	throw error instanceof Error ? error : new Error(String(error));
}

export function omit<Subject extends object, Key extends PropertyKey>(
	subject: Subject,
	keys: Key[],
) {
	const keySet = new Set<PropertyKey>(keys);
	return Object.fromEntries(
		Object.entries(subject).filter(([key]) => !keySet.has(key)),
	) as Subject extends unknown ? Omit<Subject, Key> : never;
}

export function last<T>(array: T[]): T | undefined {
	return array[array.length - 1];
}

export function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function toSnakeCase(str: string): string {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function snakeCaseDeep<T>(input: T): T {
	if (!isObject(input)) {
		return input;
	}

	if (Array.isArray(input)) {
		return input.map((item) => snakeCaseDeep(item)) as T;
	}

	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		output[toSnakeCase(key)] = snakeCaseDeep(value);
	}
	return output as T;
}
