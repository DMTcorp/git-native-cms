module.exports = {
  forbidden: [
    {
      name: "core-is-pure",
      severity: "error",
      from: { path: "^packages/core" },
      to: { path: "^packages/(application|github|server|next|astro|editor)" },
    },
    {
      name: "application-does-not-import-adapters",
      severity: "error",
      from: { path: "^packages/application" },
      to: {
        path: "^packages/(github|server|next|astro|editor|content-repository|delivery|sessions)",
      },
    },
    {
      name: "react-is-framework-neutral",
      severity: "error",
      from: { path: "^packages/react" },
      to: { path: "^packages/(next|astro)" },
    },
    {
      name: "editor-ui-has-no-domain-adapters",
      severity: "error",
      from: { path: "^packages/editor-ui" },
      to: { path: "^packages/(github|content-repository|delivery)" },
    },
    {
      name: "no-cycles",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
    },
  },
};
