"use client";

import { useEffect, useRef, useState } from "react";
import { createPreviewBridge } from "@git-native-cms/editor-bridge";
import { CmsPageRenderer, createReactRegistry, registerReactSection } from "@git-native-cms/react";
import { defineSection, fields } from "@git-native-cms/schema";
import { sandboxDocument } from "../cms.fixture";

const heroDefinition = defineSection({
  name: "hero",
  version: 1,
  label: "Hero",
  fields: {
    heading: fields.text({ required: true, inline: true }),
    description: fields.text({ inline: true }),
  },
});

const proofDefinition = defineSection({
  name: "proof",
  version: 1,
  label: "Proof",
  fields: {
    heading: fields.text({ required: true, inline: true }),
    description: fields.text({ inline: true }),
  },
});

const registry = createReactRegistry({
  sections: [
    registerReactSection(heroDefinition, ({ section }) => (
      <section className="hero">
        <div>
          <span className="hero__eyebrow">A Git-native publication</span>
          <h1>{String(section.heading)}</h1>
          <p>{String(section.description)}</p>
        </div>
        <aside className="hero__proof">
          <span>Current proof</span>
          <ol>
            <li>Change prepared</li>
            <li>Review complete</li>
            <li>Ready for staging</li>
          </ol>
        </aside>
      </section>
    )),
    registerReactSection(proofDefinition, ({ section }) => (
      <section className="site-section">
        <span className="hero__eyebrow">Publication proof</span>
        <h2>{String(section.heading)}</h2>
        <p>{String(section.description)}</p>
      </section>
    )),
  ],
});

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
        registry={registry}
        preview
      />
    </main>
  );
}
