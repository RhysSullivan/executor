const DEFAULT_INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/RhysSullivan/executor/main/install";

export async function GET(): Promise<Response> {
  const target = process.env.EXECUTOR_INSTALL_SCRIPT_URL ?? DEFAULT_INSTALL_SCRIPT_URL;
  return Response.redirect(target, 302);
}
