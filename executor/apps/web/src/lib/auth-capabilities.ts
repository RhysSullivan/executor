import { readRuntimeConfig } from "@/lib/runtime-config";

export const workosEnabled = Boolean(readRuntimeConfig().workosClientId);
