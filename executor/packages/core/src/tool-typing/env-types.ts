export const BASE_ENVIRONMENT_DTS = `
interface Console {
  /** Console output is discarded; use explicit return values for results. */
  log(...args: any[]): void;
  /** Console output is discarded; use explicit return values for results. */
  error(...args: any[]): void;
  /** Console output is discarded; use explicit return values for results. */
  warn(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
}
declare var console: Console;

declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearTimeout(id: number): void;
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearInterval(id: number): void;
`;
