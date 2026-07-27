import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./site.css";

export const metadata: Metadata = {
  title: "Git-native CMS playground",
  description: "A real Next.js site edited by the embedded Git-native CMS.",
};

export default function RootLayout(props: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  );
}
