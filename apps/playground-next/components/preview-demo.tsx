"use client";

import { useEffect, useRef, useState } from "react";
import { createPreviewBridge } from "@git-native-cms/editor-bridge";
import { CmsPageRenderer } from "@git-native-cms/react";
import { sandboxRegistry } from "../cms.registry";
import { sandboxDocument } from "../cms.fixture";

export function PreviewDemo() {
  const [document, setDocument] = useState(sandboxDocument.data);
  const documentRef = useRef(document);
  documentRef.current = document;
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("cmsSession");
    if (sessionId === null) return;
    const bridge = createPreviewBridge({
      parentOrigin: window.location.origin,
      sessionId,
      getDocument: () => documentRef.current,
      setDocument: (next) => setDocument(next as typeof document),
    });
    return () => bridge.destroy();
  }, []);
  return (
    <main className="site-shell">
      <CmsPageRenderer
        document={{ id: sandboxDocument.id, sections: document.sections }}
        registry={sandboxRegistry}
        preview
      />
    </main>
  );
}
