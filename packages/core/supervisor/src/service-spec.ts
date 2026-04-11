/**
 * Platform-neutral service descriptor passed to every {@link PlatformSupervisor}
 * method. Fields are all optional so callers can omit what the backend can
 * derive from its own defaults (e.g. the launchd backend resolves `label` to
 * `sh.executor.daemon` and `unitFilePath` to `~/Library/LaunchAgents/<label>.plist`).
 */
export interface ServiceSpec {
  /**
   * Stable identifier for the service (launchd label, systemd unit name, etc.).
   * When omitted, the backend picks its canonical default.
   */
  readonly label?: string;

  /**
   * Path to the platform-specific unit file (launchd plist, systemd .service,
   * etc.). When omitted, the backend computes it from the label.
   */
  readonly unitFilePath?: string;

  /** Path to the daemon's log file. */
  readonly logPath?: string;

  /** TCP port the daemon should bind to. Backends default to 4788. */
  readonly port?: number;

  /** Scope directory forwarded to the daemon via env/args. */
  readonly scope?: string;

  /** Extra environment variables to set on the daemon process. */
  readonly envVars?: Readonly<Record<string, string>>;

  /**
   * Full URL used for the readiness probe. When omitted, the backend derives it
   * from the port (e.g. `http://127.0.0.1:{port}/api/scope`).
   */
  readonly readinessUrl?: string;

  /** Deadline for the readiness poll after bootstrap. Defaults to 10_000ms. */
  readonly readinessTimeoutMs?: number;

  /**
   * Override for the `ProgramArguments` list launchd/systemd passes to the
   * daemon. Reserved for tests and headless invocations; normal callers should
   * leave this unset.
   */
  readonly programArgs?: readonly string[];
}

/** Returned from {@link PlatformSupervisor.install}. */
export interface InstallResult {
  readonly label: string;
  readonly unitFilePath: string;
  readonly logPath: string;
  readonly url: string;
}

/** Returned from {@link PlatformSupervisor.status}. */
export interface ServiceStatus {
  readonly label: string;
  readonly unitFilePath: string;
  readonly logPath: string;
  readonly url: string;
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid?: number;
  readonly reachable: boolean;
}

/** Default TCP port for the executor daemon. */
export const DEFAULT_SERVICE_PORT = 4788;
