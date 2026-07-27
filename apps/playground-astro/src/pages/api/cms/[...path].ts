import type { APIRoute } from "astro";
import { hostedRuntime } from "../../../cms-runtime";

export const ALL: APIRoute = async ({ request }) => await hostedRuntime.handle(request);
