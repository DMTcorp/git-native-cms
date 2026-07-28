import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./site.css";

export const metadata: Metadata = {
  title: "Git-native CMS playground",
  description: "A real Next.js site edited by the embedded Git-native CMS.",
};

export default async function RootLayout(props: { readonly children: ReactNode }) {
  const localeHeader = (await headers()).get("x-cms-locale");
  const locale = localeHeader === "en-US" || localeHeader === "pl-PL" ? localeHeader : "en-US";
  return (
    <html lang={locale}>
      <body>{props.children}</body>
    </html>
  );
}
