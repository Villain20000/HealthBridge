import { inject } from "@angular/core";
import { CanActivateFn, Router, Routes } from "@angular/router";
import { AuthStore } from "./core/auth.store";
import { ShellLayout } from "./layout/shell";

/**
 * Route table.
 *
 * Every feature is lazily loaded and grouped under one authenticated shell, so the Studio is a
 * sibling entry here rather than a second application. `authGuard` is a UX gate; the API is the
 * real authorisation boundary.
 */
const requiresConnection: CanActivateFn = (_route, state) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  if (auth.isConnected()) return true;
  return router.createUrlTree(["/connect"], { queryParams: { returnUrl: state.url } });
};

export const routes: Routes = [
  {
    path: "connect",
    title: "Connect · HealthBridge",
    loadComponent: () => import("./features/connect/connect.page").then((m) => m.ConnectPage),
  },
  {
    path: "",
    component: ShellLayout,
    canActivate: [requiresConnection],
    children: [
      { path: "", pathMatch: "full", redirectTo: "dashboard" },
      {
        path: "dashboard",
        title: "Dashboard · HealthBridge",
        loadComponent: () => import("./features/dashboard/dashboard.page").then((m) => m.DashboardPage),
      },
      {
        path: "runs",
        title: "Runs · HealthBridge",
        loadComponent: () => import("./features/runs/runs.page").then((m) => m.RunsPage),
      },
      {
        path: "runs/:id",
        title: "Run detail · HealthBridge",
        loadComponent: () => import("./features/runs/run-detail.page").then((m) => m.RunDetailPage),
      },
      {
        path: "validation-centre/:runId",
        title: "Validation Centre · HealthBridge",
        loadComponent: () =>
          import("./features/validation-centre/validation-centre.page").then((m) => m.ValidationCentrePage),
      },
      {
        path: "lineage/:runId",
        title: "Data lineage · HealthBridge",
        loadComponent: () => import("./features/lineage/lineage.page").then((m) => m.LineagePage),
      },
      {
        path: "assets",
        title: "Assets · HealthBridge",
        loadComponent: () => import("./features/assets/assets.page").then((m) => m.AssetsPage),
      },
      {
        path: "mappings",
        title: "Mappings · HealthBridge",
        loadComponent: () => import("./features/mappings/mappings.page").then((m) => m.MappingsPage),
      },
      {
        path: "mapping-editor/:mappingId",
        title: "Mapping editor · HealthBridge",
        loadComponent: () =>
          import("./features/mapping-editor/mapping-editor.page").then((m) => m.MappingEditorPage),
      },
      {
        path: "pipelines",
        title: "Pipelines · HealthBridge",
        loadComponent: () => import("./features/pipelines/pipelines.page").then((m) => m.PipelinesPage),
      },
      {
        path: "keys",
        title: "API keys · HealthBridge",
        loadComponent: () => import("./features/keys/keys.page").then((m) => m.KeysPage),
      },
      {
        path: "audit",
        title: "Audit · HealthBridge",
        loadComponent: () => import("./features/audit/audit.page").then((m) => m.AuditPage),
      },
      {
        path: "studio",
        loadChildren: () => import("./features/studio/studio.routes").then((m) => m.STUDIO_ROUTES),
      },
    ],
  },
  {
    path: "**",
    title: "Not found · HealthBridge",
    loadComponent: () => import("./features/not-found.page").then((m) => m.NotFoundPage),
  },
];
