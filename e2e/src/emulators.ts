// The suite's own service emulators. Each target boots its own Resend
// emulator (setup/<target>.boot.ts) on a per-target offset of this
// checkout's port block — the shared hosted instances at *.emulators.dev
// accumulate state until Durable Object per-value limits break credential
// minting, so suites own their upstreams.
import { e2ePort } from "./ports";

/** The Resend emulator serving this target's scenarios. */
export const resendEmulatorUrl = (targetName: string): string =>
  targetName === "selfhost"
    ? `http://127.0.0.1:${e2ePort("E2E_SELFHOST_RESEND_EMULATOR_PORT", 6)}`
    : `http://127.0.0.1:${e2ePort("E2E_RESEND_EMULATOR_PORT", 5)}`;
