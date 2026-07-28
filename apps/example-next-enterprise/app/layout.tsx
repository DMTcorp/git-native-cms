import type { ReactNode } from "react";
import "@git-native-cms/next/styles.css";
import "./styles.css";

export default function Layout(props: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  );
}
