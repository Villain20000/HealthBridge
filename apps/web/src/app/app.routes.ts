import { inject } from "@angular/core";
import { CanActivateFn, Router, Routes } from "@angular/router";
import { AuthStore } from "./core/auth.store";
import { ShellLayout } from "./layout/shell";

/**
 * Route table.
 *
 * Every feature is lazily loaded and grouped under one authenticated shell, so a future Studio
 * module is a sibling entry here rather than a second application. `authGuard` is a UX gate;
 * the API is the real authorisation boundary.
 */
const requiresConnection: CanActivateFn = () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  if (auth.isConnected()) return true;
  return router.createUrlTree(["/connect"]);
};

export const routes: Routes = [
  {
    path: "connect",
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
        loadComponent: () => import("./features/dashboard/dashboard.page").then((m) => m.DashboardPage),
      },
      { path: "runs", loadComponent: () => import("./features/runs/runs.page").then((m) => m.RunsPage) },
      { path: "runs/:id", loadComponent: () => import("./features/runs/run-detail.page").then((m) => m.RunDetailPage) },
      { path: "assets", loadComponent: () => import("./features/assets/assets.page").then((m) => m.AssetsPage) },
      {
        path: "mappings",
        loadComponent: () => import("./features/mappings/mappings.page").then((m) => m.MappingsPage),
      },
      {
        path: "pipelines",
        loadComponent: () => import("./features/pipelines/pipelines.page").then((m) => m.PipelinesPage),
      },
      { path: "keys", loadComponent: () => import("./features/keys/keys.page").then((m) => m.KeysPage) },
      { path: "audit", loadComponent: () => import("./features/audit/audit.page").then((m) => m.AuditPage) },
    ],
  },
  { path: "**", loadComponent: () => import("./features/not-found.page").then((m) => m.NotFoundPage) },
];
