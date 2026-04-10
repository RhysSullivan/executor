export {
  onepasswordPlugin,
  type OnePasswordExtension,
  type OnePasswordPluginOptions,
} from "./plugin";
export {
  OnePasswordConfig,
  Vault,
  ConnectionStatus,
  OnePasswordAuth,
  DesktopAppAuth,
  ServiceAccountAuth,
} from "./types";
export { OnePasswordError } from "./errors";
export {
  makeOnePasswordService,
  makeNativeSdkService,
  makeCliService,
  OnePasswordServiceTag,
  type OnePasswordService,
  type ResolvedAuth,
} from "./service";
