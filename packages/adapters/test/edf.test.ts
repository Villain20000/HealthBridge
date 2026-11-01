import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  EdfWfdbFormatAdapter,
  EDF_MAIN_HEADER_BYTES,
  EDF_WFDB_ADAPTER_ID,
  edfPlusMarker,
  hasEdfMagic,
  isBdfBytes,
  looksLikeWfdbRecordLine,
  parseEdfBytes,
  parseWfdbText,
} from "../src/edf.js";
import { runAdapterConformance } from "../src/kit.js";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

// ---------------------------------------------------------------------------
// In-test builders (headers only — sample bytes are never constructed)
// ---------------------------------------------------------------------------

interface TestChannel {
  label: string;
  transducer?: string;
  units?: string;
  physMin?: string;
  physMax?: string;
  digMin?: string;
  digMax?: string;
  samplesPerRecord?: string;
}

function writeField(buf: Buffer, offset: number, length: number, value: string): void {
  buf.fill(0x20, offset, offset + length);
  buf.write(value, offset, Math.min(value.length, length), "ascii");
}

function buildEdf(channels: TestChannel[], main: Record<string, string> = {}, reserved = ""): Buffer {
  const ns = channels.length;
  const headerBytes = EDF_MAIN_HEADER_BYTES + ns * 256;
  const buf = Buffer.alloc(headerBytes, 0x20);
  writeField(buf, 0, 8, main.version ?? "0       ");
  writeField(buf, 8, 80, main.patientId ?? "TestPatient");
  writeField(buf, 88, 80, main.recordingId ?? "TestRecording");
  writeField(buf, 168, 8, main.startDate ?? "01.01.26");
  writeField(buf, 176, 8, main.startTime ?? "01.02.03");
  writeField(buf, 184, 8, main.headerBytes ?? String(headerBytes));
  writeField(buf, 192, 44, reserved);
  writeField(buf, 236, 8, main.numRecords ?? "10");
  writeField(buf, 244, 8, main.duration ?? "1");
  writeField(buf, 252, 4, main.numSignals ?? String(ns));
  const base = (fieldOffset: number, slot: number): number => EDF_MAIN_HEADER_BYTES + fieldOffset + slot;
  const labelBase = 0;
  const transducerBase = ns * 16;
  const unitsBase = transducerBase + ns * 80;
  const physMinBase = unitsBase + ns * 8;
  const physMaxBase = physMinBase + ns * 8;
  const digMinBase = physMaxBase + ns * 8;
  const digMaxBase = digMinBase + ns * 8;
  const prefilterBase = digMaxBase + ns * 8;
  const samplesBase = prefilterBase + ns * 80;
  channels.forEach((channel, i) => {
    writeField(buf, base(labelBase, i * 16), 16, channel.label);
    writeField(buf, base(transducerBase, i * 80), 80, channel.transducer ?? "AgAgCl");
    writeField(buf, base(unitsBase, i * 8), 8, channel.units ?? "uV");
    writeField(buf, base(physMinBase, i * 8), 8, channel.physMin ?? "-500");
    writeField(buf, base(physMaxBase, i * 8), 8, channel.physMax ?? "500");
    writeField(buf, base(digMinBase, i * 8), 8, channel.digMin ?? "-2048");
    writeField(buf, base(digMaxBase, i * 8), 8, channel.digMax ?? "2047");
    writeField(buf, base(prefilterBase, i * 80), 80, "HP:0.1Hz");
    writeField(buf, base(samplesBase, i * 8), 8, channel.samplesPerRecord ?? "256");
    // Reserved 32 bytes per signal stay spaces.
  });
  return buf;
}

const TWO_CHANNELS: TestChannel[] = [
  { label: "EEG Fp1", units: "uV" },
  { label: "ECG II", units: "mV" },
];

const WFDB_HEA = ["100 2 360 650000", "100.dat 16 200(11) mV 12 0 1024 -2447 0 V5", "100.dat 16 200(11) mV 12 0 1024 -2447 0 MLII"].join("\n");

function collectContext(): { context: ParseContext; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const context: ParseContext = {
    adapterId: EDF_WFDB_ADAPTER_ID,
    adapterVersion: "1.0.0",
    importedAt: "2026-01-01T00:00:00.000Z",
    onIssue: (issue) => issues.push(issue),
  };
  return { context, issues };
}

async function parseAll(input: InputDescriptor): Promise<{ envelopes: MedicalDataEnvelope[]; issues: ValidationIssue[] }> {
  const adapter = new EdfWfdbFormatAdapter();
  const { context, issues } = collectContext();
  const envelopes: MedicalDataEnvelope[] = [];
  for await (const envelope of adapter.parse(input, context)) envelopes.push(envelope);
  return { envelopes, issues };
}

describe("edf-wfdb conformance", () => {
  test("kit conformance passes with zero failures", async () => {
    const failures = await runAdapterConformance(new EdfWfdbFormatAdapter());
    assert.deepEqual(failures, []);
  });

  test("manifest is honestly metadata-only with explicit limits", () => {
    const manifest = new EdfWfdbFormatAdapter().getManifest();
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.equal(manifest.capabilities.transformMetadataToFHIR, false);
    assert.ok(manifest.extensions.includes(".edf"));
    assert.ok(manifest.extensions.includes(".hea"));
    assert.ok((manifest.limitations ?? []).some((l) => /not clinically validated/i.test(l)));
    assert.ok((manifest.limitations ?? []).some((l) => /never enter envelopes/i.test(l)));
  });
});

describe("edf-wfdb detect", () => {
  test("detects EDF by magic and extension", async () => {
    const adapter = new EdfWfdbFormatAdapter();
    const buf = buildEdf(TWO_CHANNELS);
    assert.equal(await adapter.detect({ id: "a", filename: "sleep.edf", buffer: buf }), true);
    assert.equal(await adapter.detect({ id: "b", filename: "noext", buffer: buf }), true);
  });

  test("detects WFDB by record-line pattern and .hea extension", async () => {
    const adapter = new EdfWfdbFormatAdapter();
    assert.equal(await adapter.detect({ id: "a", filename: "100.hea", contentString: WFDB_HEA }), true);
    assert.ok(looksLikeWfdbRecordLine("100 2 360 650000"));
    assert.equal(looksLikeWfdbRecordLine("patient_id,first_name"), false);
  });

  test("kit samples are never claimed and detect never throws", async () => {
    const adapter = new EdfWfdbFormatAdapter();
    const samples: InputDescriptor[] = [
      { id: "kit-sample-csv", filename: "kit.csv", contentString: "patient_id,first_name\nP1,Jane\n" },
      { id: "kit-sample-json", filename: "kit.json", contentString: JSON.stringify([{ patient_id: "P1" }]) },
      { id: "kit-sample-fhir", filename: "kit.fhir.json", contentString: JSON.stringify({ resourceType: "Patient", id: "x" }) },
    ];
    for (const sample of samples) {
      assert.equal(await adapter.detect(sample), false);
      assert.equal(await adapter.score(sample), 0);
    }
  });

  test(".dat companions are recognised but never claimed", async () => {
    const adapter = new EdfWfdbFormatAdapter();
    const score = await adapter.score({ id: "a", filename: "100.dat", buffer: Buffer.from([0x01, 0x02, 0x03]) });
    assert.ok(score > 0 && score < 0.5, `expected companion-only score, got ${score}`);
    assert.equal(await adapter.detect({ id: "a", filename: "100.dat", buffer: Buffer.from([0x01, 0x02, 0x03]) }), false);
  });

  test("BDF bytes are recognised for explicit refusal", async () => {
    const adapter = new EdfWfdbFormatAdapter();
    const bdf = Buffer.alloc(256, 0x20);
    bdf[0] = 0xff;
    bdf.write("BIOSEMI", 1, "ascii");
    assert.ok(isBdfBytes(bdf));
    assert.equal(await adapter.detect({ id: "a", filename: "eeg.bdf", buffer: bdf }), true);
  });

  test("magic helpers behave", () => {
    assert.equal(hasEdfMagic(buildEdf(TWO_CHANNELS)), true);
    assert.equal(hasEdfMagic(Buffer.from("hello")), false);
    assert.equal(edfPlusMarker(buildEdf(TWO_CHANNELS)), null);
    assert.equal(edfPlusMarker(buildEdf(TWO_CHANNELS, {}, "EDF+C         ")), "EDF+C");
  });
});

describe("edf parse", () => {
  test("yields one per-recording envelope with channels, units and derived sampling", async () => {
    const { envelopes, issues } = await parseAll({ id: "a", filename: "sleep.edf", buffer: buildEdf(TWO_CHANNELS) });
    assert.equal(issues.length, 0);
    assert.equal(envelopes.length, 1);
    const [envelope] = envelopes;
    assert.equal(envelope.domain, "waveform");
    assert.equal(envelope.provenance.adapterId, EDF_WFDB_ADAPTER_ID);
    assert.equal(envelope.provenance.recordIndex, 0);
    assert.equal(envelope.provenance.sourceLocation, "header");
    assert.ok(envelope.source.checksum?.startsWith("sha256:"));
    const data = envelope.content.data as Record<string, unknown>;
    assert.equal(data.kind, "edf-recording");
    assert.equal(data.variant, "edf");
    assert.equal(data.patientId, "TestPatient");
    assert.equal(data.recordingId, "TestRecording");
    assert.equal(data.startDate, "01.01.26");
    assert.equal(data.startTime, "01.02.03");
    assert.equal(data.signalCount, 2);
    assert.equal(data.recordingDurationSec, 10);
    const channels = data.channels as Array<Record<string, unknown>>;
    assert.equal(channels.length, 2);
    assert.equal(channels[0].label, "EEG Fp1");
    assert.equal(channels[0].units, "uV");
    assert.equal(channels[0].samplingHz, 256);
    assert.equal(channels[0].byteOffsetInRecord, 0);
    assert.equal(channels[1].byteOffsetInRecord, 512);
    assert.deepEqual((data.dataLayout as Record<string, unknown>), {
      headerBytesDeclared: 768,
      dataStartOffset: 768,
      bytesPerDataRecord: 1024,
      dataRecordCount: 10,
      expectedSampleBytes: 10240,
      inputBytesObserved: 768,
    });
    assert.deepEqual(data.samples, {
      inlined: false,
      note: "Metadata only: data-record sample bytes never enter envelopes, issues or traces",
    });
  });

  test("sample bytes appended after the header never enter the envelope", async () => {
    const header = buildEdf(TWO_CHANNELS);
    const samples = Buffer.alloc(1024 * 10, 0xab);
    const { envelopes } = await parseAll({ id: "a", filename: "s.edf", buffer: Buffer.concat([header, samples]) });
    assert.equal(envelopes.length, 1);
    const serialised = JSON.stringify(envelopes[0]);
    assert.ok(!serialised.includes("ababab"), "sample payload must not be inlined");
    assert.ok(serialised.length < 20000, `envelope must stay small, got ${serialised.length}`);
    const data = envelopes[0].content.data as Record<string, unknown>;
    assert.equal((data.dataLayout as Record<string, unknown>).inputBytesObserved, header.length + samples.length);
  });

  test("EDF+ reserved marker yields the edf-plus variant", async () => {
    const { envelopes } = await parseAll({
      id: "a",
      filename: "s.edf",
      buffer: buildEdf(TWO_CHANNELS, {}, "EDF+C         "),
    });
    assert.equal(envelopes.length, 1);
    const data = envelopes[0].content.data as Record<string, unknown>;
    assert.equal(data.variant, "edf-plus");
    assert.equal(data.variantMarker, "EDF+C");
  });

  test("unknown record count (-1) yields null duration, not zero", async () => {
    const { envelopes } = await parseAll({
      id: "a",
      filename: "s.edf",
      buffer: buildEdf(TWO_CHANNELS, { numRecords: "-1" }),
    });
    assert.equal(envelopes.length, 1);
    const data = envelopes[0].content.data as Record<string, unknown>;
    assert.equal(data.dataRecordCount, null);
    assert.equal(data.recordingDurationSec, null);
    assert.equal((data.dataLayout as Record<string, unknown>).expectedSampleBytes, null);
  });

  test("refusals carry explicit codes and yield no envelopes", async () => {
    const cases: Array<{ name: string; input: InputDescriptor; code: string }> = [
      { name: "empty", input: { id: "e", filename: "s.edf" }, code: "EDF_WFDB_EMPTY_INPUT" },
      { name: "truncated main", input: { id: "e", filename: "s.edf", buffer: Buffer.alloc(100, 0x20) }, code: "EDF_TRUNCATED_MAIN_HEADER" },
      { name: "not edf", input: { id: "e", filename: "s.edf", buffer: Buffer.alloc(300, 0x20) }, code: "EDF_NOT_EDF" },
      {
        name: "truncated signals",
        input: { id: "e", filename: "s.edf", buffer: buildEdf(TWO_CHANNELS).subarray(0, 256) },
        code: "EDF_TRUNCATED_SIGNAL_HEADERS",
      },
      {
        name: "invalid count",
        input: { id: "e", filename: "s.edf", buffer: buildEdf(TWO_CHANNELS, { numSignals: "XY" }) },
        code: "EDF_INVALID_HEADER_FIELD",
      },
      {
        name: "zero signals",
        input: { id: "e", filename: "s.edf", buffer: buildEdf([], { numSignals: "0", headerBytes: "256" }) },
        code: "EDF_NO_SIGNALS",
      },
    ];
    const bdf = Buffer.alloc(256, 0x20);
    bdf[0] = 0xff;
    bdf.write("BIOSEMI", 1, "ascii");
    cases.push({ name: "bdf refused", input: { id: "e", filename: "e.bdf", buffer: bdf }, code: "EDF_BDF_REFUSED" });
    for (const { name, input, code } of cases) {
      const { envelopes, issues } = await parseAll(input);
      assert.equal(envelopes.length, 0, name);
      assert.ok(issues.some((issue) => issue.code === code), `${name}: expected ${code}, got ${JSON.stringify(issues)}`);
    }
  });

  test("parseEdfBytes is a pure structural function", () => {
    const parsed = parseEdfBytes(buildEdf(TWO_CHANNELS));
    assert.equal(parsed.refused, false);
    if (!parsed.refused) {
      assert.equal(parsed.meta.channels[1].units, "mV");
      assert.equal(parsed.meta.channels[1].samplingHz, 256);
    }
    const truncated = parseEdfBytes(Buffer.alloc(10, 0x20));
    assert.equal(truncated.refused, true);
    if (truncated.refused) assert.equal(truncated.code, "EDF_TRUNCATED_MAIN_HEADER");
  });
});

describe("wfdb parse", () => {
  test("yields one envelope with channels, duration and external companions", async () => {
    const { envelopes, issues } = await parseAll({ id: "a", filename: "100.hea", contentString: WFDB_HEA });
    assert.equal(issues.length, 0);
    assert.equal(envelopes.length, 1);
    const [envelope] = envelopes;
    assert.equal(envelope.domain, "waveform");
    assert.ok(envelope.source.checksum?.startsWith("sha256:"));
    assert.equal(envelope.provenance.adapterId, EDF_WFDB_ADAPTER_ID);
    const data = envelope.content.data as Record<string, unknown>;
    assert.equal(data.kind, "wfdb-recording");
    assert.equal(data.recordName, "100");
    assert.equal(data.samplingFrequency, 360);
    assert.equal(data.sampleCount, 650000);
    assert.ok(Math.abs((data.recordingDurationSec as number) - 650000 / 360) < 1e-9);
    const signals = data.signals as Array<Record<string, unknown>>;
    assert.equal(signals.length, 2);
    assert.equal(signals[0].fileName, "100.dat");
    assert.equal(signals[0].format, "16");
    assert.equal(signals[0].adcGain, 200);
    assert.equal(signals[0].baseline, 11);
    assert.equal(signals[0].units, "mV");
    assert.equal(signals[0].adcResolution, 12);
    assert.equal(signals[0].signalName, "V5");
    assert.deepEqual((data.companions as Record<string, unknown>).files, ["100.dat"]);
    assert.equal((data.companions as Record<string, unknown>).external, true);
    assert.deepEqual(data.samples, {
      inlined: false,
      note: "Metadata only: sample bytes never enter envelopes, issues or traces",
    });
  });

  test("refusals carry explicit codes and yield no envelopes", async () => {
    const cases: Array<{ name: string; input: InputDescriptor; code: string }> = [
      { name: "empty", input: { id: "e", filename: "x.hea" }, code: "EDF_WFDB_EMPTY_INPUT" },
      {
        name: "bad record line",
        input: { id: "e", filename: "x.hea", contentString: "not a header\nfoo bar\n" },
        code: "WFDB_INVALID_RECORD_LINE",
      },
      {
        name: "no signal lines",
        input: { id: "e", filename: "x.hea", contentString: "100 2 360 650000\n" },
        code: "WFDB_NO_SIGNAL_LINES",
      },
      {
        name: "binary companion",
        input: { id: "e", filename: "100.dat", buffer: Buffer.from([0x00, 0x01, 0x02, 0xff]) },
        code: "WFDB_BINARY_NOT_HEADER",
      },
    ];
    for (const { name, input, code } of cases) {
      const { envelopes, issues } = await parseAll(input);
      assert.equal(envelopes.length, 0, name);
      assert.ok(issues.some((issue) => issue.code === code), `${name}: expected ${code}, got ${JSON.stringify(issues)}`);
    }
  });

  test("signal-count mismatch is a warning, not a refusal", async () => {
    const { envelopes, issues } = await parseAll({
      id: "a",
      filename: "x.hea",
      contentString: "100 3 360 650000\n100.dat 16 200(11) mV 12 0 V5\n",
    });
    assert.equal(envelopes.length, 1);
    assert.ok(issues.some((issue) => issue.code === "WFDB_SIGNAL_COUNT_MISMATCH"));
  });

  test("parseWfdbText is a pure structural function", () => {
    const parsed = parseWfdbText(WFDB_HEA);
    assert.equal(parsed.refused, false);
    if (!parsed.refused) {
      assert.deepEqual(parsed.meta.companionFiles, ["100.dat"]);
      assert.equal(parsed.meta.signals[1].signalName, "MLII");
    }
    const bad = parseWfdbText("hello\n");
    assert.equal(bad.refused, true);
    if (bad.refused) assert.equal(bad.code, "WFDB_INVALID_RECORD_LINE");
  });
});

describe("edf-wfdb inspect and health", () => {
  test("inspect reports channels, duration and counts for EDF", async () => {
    const adapter = new EdfWfdbFormatAdapter();
    const result = await adapter.inspect({ id: "a", filename: "s.edf", buffer: buildEdf(TWO_CHANNELS) });
    assert.equal(result.format, "edf-wfdb");
    assert.equal(result.formatVersion, "EDF");
    assert.equal(result.domain, "waveform");
    assert.equal(result.recordCount, 1);
    assert.equal(result.detectedSchema?.fields.length, 2);
    const warnings = (result.warnings ?? []).join("\n");
    assert.ok(/Channels: 2/i.test(warnings));
    assert.ok(/Duration: 10 second/i.test(warnings));
    assert.ok(/data record/i.test(warnings));
  });

  test("inspect reports channels, duration and companions for WFDB", async () => {
    const adapter = new EdfWfdbFormatAdapter();
    const result = await adapter.inspect({ id: "a", filename: "100.hea", contentString: WFDB_HEA });
    assert.equal(result.formatVersion, "WFDB-hea");
    assert.equal(result.recordCount, 1);
    const warnings = (result.warnings ?? []).join("\n");
    assert.ok(/Channels: 2/i.test(warnings));
    assert.ok(/Duration:/.test(warnings));
    assert.ok(/100\.dat/.test(warnings));
  });

  test("inspect never throws and reports refusals as warnings", async () => {
    const adapter = new EdfWfdbFormatAdapter();
    const empty = await adapter.inspect({ id: "e", filename: "s.edf" });
    assert.equal(empty.recordCount, 0);
    const truncated = await adapter.inspect({ id: "e", filename: "s.edf", buffer: Buffer.alloc(10, 0x20) });
    assert.equal(truncated.recordCount, 0);
    assert.ok((truncated.warnings ?? []).some((w) => w.includes("EDF_TRUNCATED_MAIN_HEADER")));
    const bdf = Buffer.alloc(256, 0x20);
    bdf[0] = 0xff;
    bdf.write("BIOSEMI", 1, "ascii");
    const refused = await adapter.inspect({ id: "e", filename: "e.bdf", buffer: bdf });
    assert.equal(refused.recordCount, 0);
    assert.ok((refused.warnings ?? []).some((w) => w.includes("EDF_BDF_REFUSED")));
  });

  test("health reports metadata-only scope", async () => {
    const result = await new EdfWfdbFormatAdapter().health();
    assert.equal(result.ok, true);
    assert.ok(typeof result.details === "string" && result.details.length > 0);
    assert.ok(/metadata only/i.test(result.details));
  });
});
