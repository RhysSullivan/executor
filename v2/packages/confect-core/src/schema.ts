import { Schema } from "effect";

export const TimestampMsSchema = Schema.Number;

export const makeIdSchema = (brandName: string) =>
  Schema.String.pipe(Schema.brand(brandName));
