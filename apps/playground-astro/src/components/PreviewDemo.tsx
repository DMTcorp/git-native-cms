import { useEffect, useRef, useState } from "react";
import { createPreviewBridge } from "@git-native-cms/editor-bridge";
import { CmsPageRenderer, createReactRegistry, registerReactSection } from "@git-native-cms/react";
import { defineSection, fields } from "@git-native-cms/schema";
import { document as initialDocument } from "../cms-fixture";

const definition = (name: string, label: string) =>
  defineSection({
    name,
    version: 1,
    label,
    fields: {
      heading: fields.text({ required: true, inline: true }),
      description: fields.text({ inline: true }),
    },
  });

const registry = createReactRegistry({
  sections: [
    registerReactSection(definition("hero", "Hero"), ({ section }) => (
      <section className="hero">
        <div>
          <span className="eyebrow">Built with Astro</span>
          <h1>{String(section.heading)}</h1>
          <p>{String(section.description)}</p>
        </div>
        <aside className="release-card">
          <strong>Preview release</strong>
          <code>Change branch</code>
        </aside>
      </section>
    )),
    registerReactSection(definition("proof", "Proof"), ({ section }) => (
      <section className="proof">
        <span className="eyebrow">Renderer capability</span>
        <h2>{String(section.heading)}</h2>
        <p>{String(section.description)}</p>
      </section>
    )),
  ],
});

export function PreviewDemo() {
  const [document, setDocument] = useState(initialDocument.data);
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
    <main className="site">
      <CmsPageRenderer
        document={{ id: initialDocument.id, sections: document.sections }}
        registry={registry}
        preview
      />
    </main>
  );
}
