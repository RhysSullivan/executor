import {
  RegistryProvider,
} from "@effect-atom/atom-react";
import * as React from "react";

export const ExecutorReactProvider = (props: React.PropsWithChildren) => <RegistryProvider>{props.children}</RegistryProvider>;
