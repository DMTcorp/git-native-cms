# Architecture

## Dependency direction

`core`, `schema`, `protocol` and `document-model` are runtime-neutral. Application commands
own capability ports. Adapters depend inward on those ports; application code never imports an
adapter. Transports only parse input, construct a request context, call a command/query and map
the result.

## Durable state

- Git stores content, configuration, Change branches and review history.
- Object storage stores content-addressed assets and immutable releases.
- IndexedDB stores unsynchronized patches and editor recovery state only.

## Compatibility

The supported server runtimes are Node.js 22.12+ and Node.js 24. Pure packages use Web APIs and
are tested in browser and worker-like environments. Full Astro CMS support requires SSR.

See [ADR-0001](./docs/adr/0001-ports-and-adapters.md) and
[ADR-0002](./docs/adr/0002-deterministic-releases.md).
