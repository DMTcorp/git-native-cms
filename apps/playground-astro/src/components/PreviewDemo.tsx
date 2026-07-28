import { useEffect, useRef, useState } from "react";
import { createPreviewBridge } from "@git-native-cms/editor-bridge";
import { CmsPageRenderer } from "@git-native-cms/react";
import { sandboxRegistry } from "../cms-registry";
import { document as initialDocument } from "../cms-fixture";

export function PreviewDemo() {
  const [document, setDocument] = useState(initialDocument.data);
  const [content, setContent] = useState<readonly unknown[]>([]);
  const documentRef = useRef(document);
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
      setDocument: (next) => setDocument(next as typeof document),
      setContent,
      getContent: () => contentRef.current,
    });
    return () => bridge.destroy();
  }, []);
  return (
    <main className="site">
      <CmsPageRenderer
        document={{ id: initialDocument.id, sections: document.sections }}
        registry={sandboxRegistry}
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
