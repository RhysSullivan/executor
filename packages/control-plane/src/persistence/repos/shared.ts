import * as Option from "effect/Option";

export const firstOption = <A>(rows: ReadonlyArray<A>): Option.Option<A> =>
  rows.length > 0 ? Option.some(rows[0] as A) : Option.none<A>();

export const withoutCreatedAt = <A extends { createdAt: unknown }>(
  value: A,
): Omit<A, "createdAt"> => {
  const { createdAt: _createdAt, ...rest } = value;
  return rest;
};
