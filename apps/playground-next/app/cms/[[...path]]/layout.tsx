import type { ReactNode } from "react";
import "@git-native-cms/editor-ui/styles.css";

export default function CmsLayout(props: { readonly children: ReactNode }) {
  return props.children;
}
