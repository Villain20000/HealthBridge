import { createHash } from "node:crypto";
import { createBuiltInAdapters } from "@healthbridge/adapters";
import type { AdapterRegistry, MedicalFormatAdapter } from "@healthbridge/core";
import type { CapabilityManifest, FormatCapabilities } from "@healthbridge/shared-types";

/**
 * Plugin manifest and signature gating for adapter registration.
 *
 * A registered adapter runs in-process with full filesystem and network access,
 * so installing a third-party adapter is arbitrary code execution (see
 * SECURITY.md: "Plugins are privileged code"). This module adds an identity
 * gate at registration time: every non-built-in adapter must present a signed
 * manifest binding its id, version and capability set to a recorded signature.
 * The gate proves *which* code the operator approved — it is not a sandbox and
 * does not make third-party code safe to run.
 *
 * Built-in adapters (shipped in `@healthbridge/adapters` and used by the
 * engine, SDK, CLI and API by default) are auto-trusted and need no manifest.
 * A manifest supplied for a built-in adapter is still consistency-checked, so
 * a stale copy cannot quietly widen its capabilities.
 */

export type PluginErrorCode =
  "PLUGIN_UNSIGNED" | "PLUGIN_ID_MISMATCH" | "PLUGIN_VERSION_MISMATCH" | "PLUGIN_CAPABILITIES_MISMATCH";

export class PluginError extends Error {
  public readonly code: PluginErrorCode;
  public readonly details?: unknown;

  constructor(code: PluginErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Signed identity record for one adapter build. `signature` is an opaque,
 * operator-recorded approval token (e.g. a cosign bundle reference or an
 * internal change id) — its presence proves a signing step happened
 * out-of-band; verification here checks presence and binding, not cryptography.
 */
export interface PluginManifest {
  /** Must equal `adapter.id`. */
  id: string;
  /** Must equal `adapter.version`. */
  version: string;
  /** Must equal `computeCapabilitiesHash(adapter.getManifest())`. */
  capabilitiesHash: string;
  /** Absent or empty for built-in adapters; required for third-party plugins. */
  signature?: string;
  /** Who or what recorded the approval (key id, system name, …). */
  signer?: string;
  /** When the approval was recorded (ISO-8601). Informational only. */
  signedAt?: string;
}

function loadBuiltInIds(): ReadonlySet<string> {
  return new Set(createBuiltInAdapters().map((adapter) => adapter.id));
}

/** Ids shipped in `@healthbridge/adapters`; auto-trusted, manifest optional. */
export const BUILT_IN_ADAPTER_IDS: readonly string[] = [...loadBuiltInIds()];

/** True for adapters shipped in `@healthbridge/adapters`. */
export function isBuiltInAdapter(adapter: Pick<MedicalFormatAdapter, "id">): boolean {
  return BUILT_IN_ADAPTER_IDS.includes(adapter.id);
}

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Fingerprint of an adapter's declared capability set (`sha256:…` over the
 * stable serialization). Any added, removed or widened capability changes the
 * hash, so a manifest signed for one capability set cannot be reused after the
 * adapter's manifest is edited.
 */
export function computeCapabilitiesHash(manifest: CapabilityManifest): string;
export function computeCapabilitiesHash(capabilities: FormatCapabilities): string;
export function computeCapabilitiesHash(input: CapabilityManifest | FormatCapabilities): string {
  const capabilities = (input as CapabilityManifest).capabilities ?? (input as FormatCapabilities);
  return `sha256:${createHash("sha256").update(stableStringify(capabilities), "utf-8").digest("hex")}`;
}

/** Builds the manifest a signing step would approve for this adapter build. */
export function createPluginManifest(
  adapter: MedicalFormatAdapter,
  approval?: { signature?: string; signer?: string; signedAt?: string },
): PluginManifest {
  return {
    id: adapter.id,
    version: adapter.version,
    capabilitiesHash: computeCapabilitiesHash(adapter.getManifest()),
    ...(approval?.signature !== undefined ? { signature: approval.signature } : {}),
    ...(approval?.signer !== undefined ? { signer: approval.signer } : {}),
    ...(approval?.signedAt !== undefined ? { signedAt: approval.signedAt } : {}),
  };
}

export interface PluginVerification {
  trusted: true;
  /** `built-in` needs no manifest; `signed` presented a bound signature. */
  reason: "built-in" | "signed";
}

/**
 * Verifies that `manifest` authorises `adapter`. Throws {@link PluginError}
 * with an explicit code when the plugin is unsigned or the binding does not
 * match. Field checks run before the signature check so a caller learns *what*
 * drifted, not just that verification failed.
 */
export function verifyPluginManifest(adapter: MedicalFormatAdapter, manifest?: PluginManifest): PluginVerification {
  const builtIn = isBuiltInAdapter(adapter);

  if (!manifest) {
    if (builtIn) return { trusted: true, reason: "built-in" };
    throw new PluginError(
      "PLUGIN_UNSIGNED",
      `Refusing to register third-party adapter '${adapter.id}': no plugin manifest was provided. ` +
        `Third-party adapters are privileged code (see SECURITY.md) — sign the adapter's ` +
        `id/version/capabilities with createPluginManifest and present the manifest at registration.`,
      { adapterId: adapter.id },
    );
  }

  if (manifest.id !== adapter.id) {
    throw new PluginError(
      "PLUGIN_ID_MISMATCH",
      `Plugin manifest id '${manifest.id}' does not match adapter id '${adapter.id}'.`,
      { manifestId: manifest.id, adapterId: adapter.id },
    );
  }

  if (manifest.version !== adapter.version) {
    throw new PluginError(
      "PLUGIN_VERSION_MISMATCH",
      `Plugin manifest version '${manifest.version}' does not match adapter version '${adapter.version}'. ` +
        `Re-sign the manifest for the adapter build being registered.`,
      { manifestVersion: manifest.version, adapterVersion: adapter.version },
    );
  }

  const expectedHash = computeCapabilitiesHash(adapter.getManifest());
  if (manifest.capabilitiesHash !== expectedHash) {
    throw new PluginError(
      "PLUGIN_CAPABILITIES_MISMATCH",
      `Plugin manifest capabilities hash does not match adapter '${adapter.id}'. ` +
        `The adapter's declared capabilities changed after the manifest was signed — re-inspect and re-sign.`,
      { manifestHash: manifest.capabilitiesHash, adapterHash: expectedHash },
    );
  }

  if (!builtIn && (!manifest.signature || manifest.signature.length === 0)) {
    throw new PluginError(
      "PLUGIN_UNSIGNED",
      `Refusing to register third-party adapter '${adapter.id}': the manifest carries no signature. ` +
        `Record an out-of-band approval (see PluginManifest.signature) before registering privileged code.`,
      { adapterId: adapter.id },
    );
  }

  return { trusted: true, reason: builtIn ? "built-in" : "signed" };
}

/**
 * Verified registration: checks the manifest binding first, then registers.
 * `AdapterRegistry.register` still rejects duplicate ids with its own error.
 */
export function registerPluginAdapter(
  registry: AdapterRegistry,
  adapter: MedicalFormatAdapter,
  manifest?: PluginManifest,
): MedicalFormatAdapter {
  verifyPluginManifest(adapter, manifest);
  registry.register(adapter);
  return adapter;
}
