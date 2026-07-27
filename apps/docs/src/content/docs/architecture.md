---
title: Architecture
description: Ports, adapters and one command layer.
---

Pure packages contain schema, protocol, document and domain behavior. Application commands own
the ports they require. GitHub, storage and framework packages implement those ports and depend
inward.

Public pages never import the editor or preview bridge. The bridge is a separate preview-only
entry point, and the `/cms` application is a separate route chunk.
