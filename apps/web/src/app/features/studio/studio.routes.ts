import { Routes } from "@angular/router";

/**
 * Studio routes.
 *
 * The Studio is a lazy sibling of the console features. The stored-trace debugger is a child
 * of this file so the application route table owns only the `/studio` boundary. Both entries
 * are lazy; the debugger reads stored rows and never attaches to a run.
 */
export const STUDIO_ROUTES: Routes = [
  {
    path: "",
    pathMatch: "full",
    title: "Studio · HealthBridge",
    loadComponent: () => import("./studio-home.page").then((m) => m.StudioHomePage),
  },
  {
    path: "debugger/:runId",
    title: "Debugger · HealthBridge",
    loadComponent: () => import("./debugger/debugger.page").then((m) => m.DebuggerPage),
  },
];
