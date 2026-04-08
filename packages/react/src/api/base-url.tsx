const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

let baseUrl =
  typeof window !== "undefined" && typeof window.location?.origin === "string"
    ? `${window.location.origin}/api`
    : `${DEFAULT_BASE_URL}/api`;

export const getBaseUrl = (): string => baseUrl;

export const setBaseUrl = (url: string): void => {
  baseUrl = url;
};
