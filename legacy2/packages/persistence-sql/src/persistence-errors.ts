import {
  RowStoreError,
  SourceStoreError,
  ToolArtifactStoreError,
} from "@executor-v2/persistence-ports";
import * as ParseResult from "effect/ParseResult";

import { type SqlBackend } from "./sql-internals";

const toBackendLabel = (backend: SqlBackend): string => `sql-${backend}`;

const toErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toParseDetails = (cause: unknown): string | null =>
  ParseResult.isParseError(cause)
    ? ParseResult.TreeFormatter.formatErrorSync(cause)
    : null;

export const toRowStoreError = (
  backend: SqlBackend,
  operation: string,
  location: string,
  cause: unknown,
): RowStoreError =>
  new RowStoreError({
    operation,
    backend: toBackendLabel(backend),
    location,
    message: toErrorMessage(cause),
    reason: null,
    details: toParseDetails(cause),
  });

export const toSourceStoreError = (
  backend: SqlBackend,
  operation: string,
  location: string,
  cause: unknown,
): SourceStoreError =>
  new SourceStoreError({
    operation,
    backend: toBackendLabel(backend),
    location,
    message: toErrorMessage(cause),
    reason: null,
    details: toParseDetails(cause),
  });

export const toToolArtifactStoreError = (
  backend: SqlBackend,
  operation: string,
  location: string,
  cause: unknown,
): ToolArtifactStoreError =>
  new ToolArtifactStoreError({
    operation,
    backend: toBackendLabel(backend),
    location,
    message: toErrorMessage(cause),
    reason: null,
    details: toParseDetails(cause),
  });
