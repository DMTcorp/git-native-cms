import { headers } from "next/headers";
import { hostedRuntime } from "../../../cms.runtime";
import { CmsDemo } from "../../../components/cms-demo";

export const dynamic = "force-dynamic";

export default async function CmsPage(props: {
  readonly params: Promise<{ readonly path?: readonly string[] }>;
}) {
  const requestHeaders = await headers();
  const params = await props.params;
  const state = await hostedRuntime.editorState(
    requestHeaders.get("cookie"),
    params.path?.join("/") ?? "",
  );
  return <CmsDemo state={state} />;
}
