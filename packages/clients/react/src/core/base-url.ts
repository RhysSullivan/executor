const DEFAULT_EXECUTOR_API_BASE_URL = "http://127.0.0.1:8788";

let apiBaseUrl =
  typeof window !== "undefined" && typeof window.location?.origin === "string"
    ? window.location.origin
    : DEFAULT_EXECUTOR_API_BASE_URL;

export const getExecutorApiBaseUrl = (): string => apiBaseUrl;

export const setExecutorApiBaseUrl = (baseUrl: string): void => {
  apiBaseUrl = baseUrl;
};
