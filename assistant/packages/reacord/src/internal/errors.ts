import { Data } from "effect";

export class ReacordError extends Data.TaggedError("ReacordError")<{
	message: string;
	cause?: unknown;
}> {}

export class DiscordApiError extends Data.TaggedError("DiscordApiError")<{
	operation: string;
	cause: unknown;
}> {}
