import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CsvFormatAdapter } from "@healthbridge/adapters";
import { AdapterRegistry, type MedicalFormatAdapter } from "@healthbridge/core";
import type {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  ParseContext,
} from "@healthbridge/shared-types";
import {
  BUILT_IN_ADAPTER_IDS,
  PluginError,
  computeCapabilitiesHash,
  createPluginManifest,
  isBuiltInAdapter,
  registerPluginAdapter,
  stableStringify,
  verifyPluginManifest,
} from "../src/plugins.js";

/** Minimal third-party adapter: never matches, carries a fixed manifest. */
class StubAdapter implements MedicalFormatAdapter {
  public id = "stub-example-adapter";
  public version = "0.1.0";
  private readonly manifest: CapabilityManifest = {
    format: "stub-example",
    version: "0.1.0",
    description: "Test-only third-party adapter",
    extensions: [".stub"],
    mimeTypes: ["application/x-stub"],
    status: "supported",
    capabilities: {
      register: true,
      parseMetadata: true,
      parseStructured: true,
      preview: true,
      transformMetadataToFHIR: false,
      transformToFHIR: false,
      validateFormat: true,
      exportOriginal: true,
    },
  };

  public getManifest(): CapabilityManifest {
    return this.manifest;
  }

  public async detect(_input: InputDescriptor): Promise<boolean> {
    return false;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    return {
      format: "stub-example",
      domain: "unknown",
      recordCount: 0,
      capabilities: this.manifest.capabilities,
      status: this.manifest.status,
      warnings: [`stub saw ${input.filename ?? input.id}`],
    };
  }

  public async *parse(): AsyncIterable<MedicalDataEnvelope> {
    // No records: a stub never claims input.
  }

  public withCapabilities(patch: Partial<CapabilityManifest["capabilities"]>): StubAdapter {
    const clone = new StubAdapter();
    (clone as { manifest: CapabilityManifest }).manifest = {
      ...this.manifest,
      capabilities: { ...this.manifest.capabilities, ...patch },
    };
    return clone;
  }
}

function signed(adapter: StubAdapter): ReturnType<typeof createPluginManifest> {
  return createPluginManifest(adapter, { signature: "test-approval-1", signer: "test-suite" });
}

describe("plugin manifest gating", () => {
  test("built-in adapters are auto-trusted without a manifest", () => {
    const csv = new CsvFormatAdapter();
    assert.ok(isBuiltInAdapter(csv));
    assert.ok(BUILT_IN_ADAPTER_IDS.includes("csv-adapter"));
    assert.deepEqual(verifyPluginManifest(csv), { trusted: true, reason: "built-in" });

    const registry = new AdapterRegistry();
    registerPluginAdapter(registry, csv);
    assert.equal(registry.get("csv-adapter"), csv);
  });

  test("a matching manifest for a built-in adapter is still consistency-checked", () => {
    const csv = new CsvFormatAdapter();
    const manifest = createPluginManifest(csv);
    assert.deepEqual(verifyPluginManifest(csv, manifest), { trusted: true, reason: "built-in" });

    assert.throws(
      () => verifyPluginManifest(csv, { ...manifest, version: "9.9.9" }),
      (error: unknown) => error instanceof PluginError && error.code === "PLUGIN_VERSION_MISMATCH",
    );
  });

  test("a signed third-party adapter registers and verifies", () => {
    const stub = new StubAdapter();
    assert.equal(isBuiltInAdapter(stub), false);
    assert.deepEqual(verifyPluginManifest(stub, signed(stub)), { trusted: true, reason: "signed" });

    const registry = new AdapterRegistry();
    registerPluginAdapter(registry, stub, signed(stub));
    assert.equal(registry.get(stub.id), stub);
  });

  test("a third-party adapter without a manifest is refused as unsigned", () => {
    const stub = new StubAdapter();
    assert.throws(
      () => verifyPluginManifest(stub),
      (error: unknown) => error instanceof PluginError && error.code === "PLUGIN_UNSIGNED",
    );
    assert.throws(
      () => registerPluginAdapter(new AdapterRegistry(), stub),
      (error: unknown) => error instanceof PluginError && error.code === "PLUGIN_UNSIGNED",
    );
  });

  test("a manifest without a signature is refused as unsigned", () => {
    const stub = new StubAdapter();
    assert.throws(
      () => verifyPluginManifest(stub, createPluginManifest(stub)),
      (error: unknown) => error instanceof PluginError && error.code === "PLUGIN_UNSIGNED",
    );
    assert.throws(
      () => verifyPluginManifest(stub, createPluginManifest(stub, { signature: "" })),
      (error: unknown) => error instanceof PluginError && error.code === "PLUGIN_UNSIGNED",
    );
  });

  test("id, version and capability drift each get an explicit code", () => {
    const stub = new StubAdapter();
    const manifest = signed(stub);

    assert.throws(
      () => verifyPluginManifest(stub, { ...manifest, id: "other-adapter" }),
      (error: unknown) => error instanceof PluginError && error.code === "PLUGIN_ID_MISMATCH",
    );
    assert.throws(
      () => verifyPluginManifest(stub, { ...manifest, version: "0.2.0" }),
      (error: unknown) => error instanceof PluginError && error.code === "PLUGIN_VERSION_MISMATCH",
    );

    // Capabilities widened after signing: the old hash no longer binds.
    const widened = stub.withCapabilities({ transformMetadataToFHIR: true });
    assert.throws(
      () => verifyPluginManifest(widened, manifest),
      (error: unknown) => error instanceof PluginError && error.code === "PLUGIN_CAPABILITIES_MISMATCH",
    );
    // Re-signing the widened build verifies again.
    assert.deepEqual(verifyPluginManifest(widened, signed(widened)), { trusted: true, reason: "signed" });
  });

  test("the capabilities hash is stable and sensitive to every flag", () => {
    const stub = new StubAdapter();
    const first = computeCapabilitiesHash(stub.getManifest());
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first, computeCapabilitiesHash(stub.getManifest().capabilities));
    assert.equal(first, createPluginManifest(stub).capabilitiesHash);
    assert.notEqual(first, computeCapabilitiesHash(stub.withCapabilities({ preview: false }).getManifest()));
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  });

  test("a duplicate registration still fails at the registry", () => {
    const registry = new AdapterRegistry();
    const stub = new StubAdapter();
    registerPluginAdapter(registry, stub, signed(stub));
    assert.throws(() => registerPluginAdapter(registry, stub, signed(stub)), /already registered/);
  });

  test("verification never executes the adapter", async () => {
    // Verification is manifest-only: detect/inspect/parse are untouched.
    let touched = false;
    class CountingAdapter extends StubAdapter {
      public override async detect(input: InputDescriptor): Promise<boolean> {
        touched = true;
        return super.detect(input);
      }
    }
    const adapter = new CountingAdapter();
    verifyPluginManifest(adapter, signed(adapter));
    assert.equal(touched, false);
    const context = { adapterId: adapter.id, adapterVersion: adapter.version } as ParseContext;
    for await (const _envelope of adapter.parse({ id: "x" }, context)) {
      assert.fail("stub must yield no records");
    }
    assert.equal(touched, false);
  });
});
