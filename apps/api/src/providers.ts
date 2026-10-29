import type { AppContext } from "./app.context.js";

/**
 * The single DI token for the composition root.
 *
 * Controllers receive an `AppContext` instead of six separate providers: fewer
 * injection sites, and a controller cannot accidentally get a different copy of
 * the repositories than the worker.
 */
export const APP_CONTEXT = Symbol("HEALTHBRIDGE_APP_CONTEXT");

export type { AppContext };
