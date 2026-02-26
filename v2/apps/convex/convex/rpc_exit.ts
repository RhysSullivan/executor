type RpcExitSuccess<T> = {
  _tag: "Success";
  value: T;
};

type RpcExitFailure = {
  _tag: "Failure";
  cause: unknown;
};

const isRpcExitSuccess = <T>(value: unknown): value is RpcExitSuccess<T> =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "Success" &&
  "value" in value;

const isRpcExitFailure = (value: unknown): value is RpcExitFailure =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "Failure";

const renderUnknown = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const unwrapRpcSuccess = <T>(value: unknown, endpoint: string): T => {
  if (isRpcExitSuccess<T>(value)) {
    return value.value;
  }

  if (isRpcExitFailure(value)) {
    throw new Error(
      `RPC endpoint '${endpoint}' returned failure exit: ${renderUnknown(value.cause)}`,
    );
  }

  throw new Error(
    `RPC endpoint '${endpoint}' returned invalid exit payload: ${renderUnknown(value)}`,
  );
};
