"use client";

import type { ReactElement } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
  type RouteComponent,
} from "@tanstack/react-router";

export const EDITOR_ROUTE_MAP = {
  home: "/",
  changes: "/changes",
  newChange: "/changes/new",
  change: "/changes/$changeId",
  page: "/changes/$changeId/pages/$documentId",
  collection: "/changes/$changeId/collections/$type/$entryId",
  global: "/changes/$changeId/globals/$type/$entryId",
  staging: "/staging",
  releases: "/releases",
  assets: "/assets",
  team: "/team",
  settings: "/settings",
  developer: "/developer",
} as const;

export interface EditorRouterComponents {
  readonly dashboard: RouteComponent;
  readonly newChange?: RouteComponent;
  readonly change: RouteComponent;
  readonly document: RouteComponent;
  readonly staging: RouteComponent;
  readonly releases: RouteComponent;
  readonly assets: RouteComponent;
  readonly team?: RouteComponent;
  readonly settings: RouteComponent;
  readonly developer?: RouteComponent;
}

export function createEditorRouter(input: {
  readonly initialPath: string;
  readonly components: EditorRouterComponents;
}): AnyRouter {
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.home,
    component: input.components.dashboard,
  });
  const changes = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.changes,
    component: input.components.dashboard,
  });
  const newChange = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.newChange,
    component: input.components.newChange ?? input.components.dashboard,
  });
  const change = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.change,
    component: input.components.change,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.page,
    component: input.components.document,
  });
  const collection = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.collection,
    component: input.components.document,
  });
  const global = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.global,
    component: input.components.document,
  });
  const staging = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.staging,
    component: input.components.staging,
  });
  const releases = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.releases,
    component: input.components.releases,
  });
  const assets = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.assets,
    component: input.components.assets,
  });
  const team = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.team,
    component: input.components.team ?? input.components.settings,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.settings,
    component: input.components.settings,
  });
  const developer = createRoute({
    getParentRoute: () => root,
    path: EDITOR_ROUTE_MAP.developer,
    component: input.components.developer ?? input.components.settings,
  });
  return createRouter({
    routeTree: root.addChildren([
      home,
      changes,
      newChange,
      change,
      page,
      collection,
      global,
      staging,
      releases,
      assets,
      team,
      settings,
      developer,
    ]),
    history: createMemoryHistory({ initialEntries: [input.initialPath] }),
  });
}

export function CmsEditorRouter(props: { readonly router: AnyRouter }): ReactElement {
  return <RouterProvider router={props.router} />;
}
