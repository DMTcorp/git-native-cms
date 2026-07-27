import { headers } from "next/headers";
import { hostedRuntime } from "../../../cms.runtime";
import { CmsDemo } from "../../../components/cms-demo";

export const dynamic = "force-dynamic";

export default async function CmsPage() {
  const requestHeaders = await headers();
  const state = await hostedRuntime.editorState(requestHeaders.get("cookie"));
  return <CmsDemo state={state} />;
}
