import { createNextCmsRouteHandlers } from "@git-native-cms/next/server";
import { cmsServer } from "../../../../cms.runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST, PATCH, PUT, DELETE } = createNextCmsRouteHandlers(cmsServer);
