import { hostedRuntime } from "../../../../cms.runtime";

const handle = (request: Request) => hostedRuntime.handle(request);

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
