import {
  emptyHttpCredentials,
  type HttpCredentialsState,
} from "@executor/react/plugins/http-credentials";

export const initialGraphqlCredentials = (): HttpCredentialsState =>
  emptyHttpCredentials();
