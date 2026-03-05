import { getControlPlaneRuntime } from "../../../../lib/control-plane/server";


const handler = async (request: Request): Promise<Response> => {
  const controlPlaneRuntime = await getControlPlaneRuntime();
  return controlPlaneRuntime.handleRuntimeToolCall(request);
};

export const POST = handler;
