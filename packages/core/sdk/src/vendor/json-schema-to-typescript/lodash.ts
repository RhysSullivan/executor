export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const cloneDeep = <T>(value: T): T => structuredClone(value);

export const endsWith = (value: string, suffix: string): boolean => value.endsWith(suffix);

export const merge = <T extends Record<string, unknown>>(
  target: T,
  ...sources: ReadonlyArray<Record<string, unknown> | undefined>
): T => {
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      const current = target[key];
      target[key] =
        isPlainObject(current) && isPlainObject(value)
          ? merge({ ...current }, value)
          : cloneDeep(value);
    }
  }
  return target;
};

export const findKey = <T>(
  object: Record<string, T> | undefined,
  predicate: (value: T, key: string) => boolean,
): string | undefined => {
  if (!object) return undefined;
  for (const [key, value] of Object.entries(object)) {
    if (predicate(value, key)) return key;
  }
  return undefined;
};

export const includes = <T>(array: ReadonlyArray<T>, value: T): boolean => array.includes(value);

export const map = <T, U>(
  object: Record<string, T> | undefined,
  iteratee: (value: T, key: string) => U,
): U[] => (object ? Object.entries(object).map(([key, value]) => iteratee(value, key)) : []);

export const memoize = <F extends (arg: any, ...rest: any[]) => any>(fn: F): F => {
  const cache = new Map<Parameters<F>[0], ReturnType<F>>();
  return ((arg: Parameters<F>[0], ...rest: unknown[]) => {
    if (cache.has(arg)) return cache.get(arg);
    const value = fn(arg, ...rest);
    cache.set(arg, value);
    return value;
  }) as F;
};

export const omit = <T extends object, K extends keyof T>(object: T, ...keys: K[]): Omit<T, K> => {
  const omitted = new Set<PropertyKey>(keys);
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !omitted.has(key)),
  ) as Omit<T, K>;
};

export const uniqBy = <T>(items: ReadonlyArray<T>, iteratee: (value: T) => string): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = iteratee(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

export const deburr = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export const trim = (value: string): string => value.trim();

export const upperFirst = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
