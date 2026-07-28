import type { APIRoute } from "astro";
import { hostedRuntime } from "virtual:git-native-cms/runtime";

export const ALL: APIRoute = async ({ request }) => hostedRuntime.handle(request);
