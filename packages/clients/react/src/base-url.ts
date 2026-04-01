const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

let baseUrl =
  typeof window !== "undefined" && typeof window.location?.origin === "string"
    ? window.location.origin
    : DEFAULT_BASE_URL;

export const getBaseUrl = (): string => baseUrl;

export const setBaseUrl = (url: string): void => {
  baseUrl = url;
};
