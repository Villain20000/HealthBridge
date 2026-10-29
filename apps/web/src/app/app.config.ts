import { ApplicationConfig, provideZoneChangeDetection } from "@angular/core";
import { provideHttpClient, withFetch, withInterceptors } from "@angular/common/http";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { routes } from "./app.routes";
import { apiInterceptor } from "./core/api.interceptor";

/**
 * `withFetch` matters twice here: it is the modern transport, and the SSE client needs the
 * streaming fetch implementation rather than XHR.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([apiInterceptor])),
  ],
};
