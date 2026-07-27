import type { APIRoute } from "astro";
import { cmsServer } from "../../../cms-runtime";

export const ALL: APIRoute = ({ request }) => cmsServer.handle(request);
