"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPreviewBridge } from "@git-native-cms/editor-bridge";
import { CmsPageRenderer, type CmsPageDocument } from "@git-native-cms/react";
import { enterpriseHomeDocument } from "../../../../cms.content";
import { enterpriseRegistry } from "../../../../cms.registry";

export function EnterprisePreview(): ReactElement {
  const [document, setDocument] = useState<CmsPageDocument>(enterpriseHomeDocument);
  const [content, setContent] = useState<readonly unknown[]>([]);
  const documentRef = useRef<CmsPageDocument>(document);
  const contentRef = useRef(content);
  documentRef.current = document;
  contentRef.current = content;

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("cmsSession");
    if (sessionId === null) return;
    const bridge = createPreviewBridge({
      parentOrigin: window.location.origin,
      sessionId,
      getDocument: () => documentRef.current,
      setDocument: (next) => setDocument(next as CmsPageDocument),
      setContent,
      getContent: () => contentRef.current,
    });
    return () => bridge.destroy();
  }, []);

  return (
    <main>
      <CmsPageRenderer
        document={document}
        registry={enterpriseRegistry}
        content={content.flatMap((value) => {
          if (typeof value !== "object" || value === null) return [];
          const item = value as {
            readonly id?: unknown;
            readonly type?: unknown;
            readonly data?: unknown;
          };
          return typeof item.id === "string" &&
            typeof item.type === "string" &&
            typeof item.data === "object" &&
            item.data !== null
            ? [
                {
                  id: item.id,
                  type: item.type,
                  data: item.data as Readonly<Record<string, unknown>>,
                },
              ]
            : [];
        })}
        preview
      />
    </main>
  );
}
