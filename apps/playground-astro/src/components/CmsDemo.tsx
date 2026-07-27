import type { HostedEditorState } from "@git-native-cms/hosted-runtime";
import { CmsHostedApp } from "@git-native-cms/hosted-runtime/react";

export function CmsDemo(props: { readonly state: HostedEditorState }) {
  return <CmsHostedApp state={props.state} />;
}
