import { credentialSlotPart } from "@executor-js/sdk/shared";

export type HttpCredentialSection = "request" | "specFetch" | "introspection";
export type HttpCredentialPlacement = "headers" | "query";

export const httpCredentialSlotKey = (
  section: HttpCredentialSection,
  placement: HttpCredentialPlacement,
  name: string,
): string => `${section}.${placement}.${credentialSlotPart(name)}`;

export const httpHeaderSlotKey = (section: HttpCredentialSection, name: string): string =>
  httpCredentialSlotKey(section, "headers", name);

export const httpQuerySlotKey = (section: HttpCredentialSection, name: string): string =>
  httpCredentialSlotKey(section, "query", name);

export const httpOAuthConnectionSlotKey = (section: HttpCredentialSection): string =>
  `${section}.oauth.connection`;

export const httpOAuthClientIdSlotKey = (section: HttpCredentialSection): string =>
  `${section}.oauth.clientId`;

export const httpOAuthClientSecretSlotKey = (section: HttpCredentialSection): string =>
  `${section}.oauth.clientSecret`;

export const httpSectionSlotPrefix = (section: HttpCredentialSection): string => `${section}.`;
