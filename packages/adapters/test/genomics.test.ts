import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FastaFastqFormatAdapter,
  MAX_PREVIEW_BASES,
  VcfFormatAdapter,
  guessQualityEncoding,
  runAdapterConformance,
} from "@healthbridge/adapters";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

const VCF_SAMPLE = [
  "##fileformat=VCFv4.2",
  "##reference=file:///ref/hg19.fasta",
  "##contig=<ID=chr1,length=248956422>",
  "##contig=<ID=chr2,length=242193529>",
  '##INFO=<ID=DP,Number=1,Type=Integer,Description="Total Depth">',
  '##INFO=<ID=AF,Number=A,Type=Float,Description="Allele Frequency">',
  '##INFO=<ID=H2,Number=0,Type=Flag,Description="HapMap2 membership">',
  '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
  "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA001\tNA002",
  "chr1\t10177\trs367896724\tA\tAC\t100\tPASS\tDP=14;AF=0.5,0.1;H2\tGT\t0/1\t1/1",
  "chr1\t10352\t.\tT\tTA\t.\tq10\tDP=11\tGT\t0/0\t0/1",
  "chr2\t20000\tdel1\tG\t<DEL>\t50\tPASS\tDP=30\tGT\t1/1\t0/1",
  "chr2\tBADLINE",
  "chr2\tnotapos\tbad1\tA\tT\t10\tPASS\tDP=1",
].join("\n");

const FASTA_SAMPLE = [">seq1 first record", "ACGTACGTACGT", ">seq2", "GGGCCC", "AAATTT"].join("\n");

const LONG_SEQ = "ACGT".repeat(50); // 200 bases — must never be fully inlined
const FASTA_LONG = `>long1 description\n${LONG_SEQ}\n`;

const FASTQ_SAMPLE = ["@read1 description", "ACGTACGT", "+", "IIIIIIII", "@read2", "TTTTGGGG", "+", "FFFFFFFF"].join(
  "\n",
);

function contextFor(adapter: MedicalFormatAdapter, options?: Record<string, unknown>): ParseContext {
  return { adapterId: adapter.id, adapterVersion: adapter.version, options };
}

async function collect(
  adapter: MedicalFormatAdapter,
  input: InputDescriptor,
  context: ParseContext,
): Promise<{ envelopes: MedicalDataEnvelope[]; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const envelopes: MedicalDataEnvelope[] = [];
  for await (const envelope of adapter.parse(input, { ...context, onIssue: (issue) => issues.push(issue) })) {
    envelopes.push(envelope);
  }
  return { envelopes, issues };
}

function structuredData(envelope: MedicalDataEnvelope): Record<string, unknown> {
  assert.equal(envelope.content.kind, "structured");
  if (envelope.content.kind !== "structured") throw new Error("unreachable");
  return envelope.content.data as Record<string, unknown>;
}

describe("VCF adapter", () => {
  const adapter = new VcfFormatAdapter();

  test("manifest is honestly metadata-only with no FHIR transform", () => {
    const manifest = adapter.getManifest();
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.ok(manifest.limitations?.some((l) => l.includes("no clinical interpretation")));
  });

  test("detects VCF by extension and header, rejects other content", async () => {
    assert.equal(await adapter.detect({ id: "v-1", filename: "calls.vcf", contentString: VCF_SAMPLE }), true);
    assert.equal(
      await adapter.detect({ id: "v-2", filename: "unknown.txt", contentString: "##fileformat=VCFv4.2\n" }),
      true,
    );
    assert.equal(await adapter.detect({ id: "v-3", filename: "note.txt", contentString: "plain prose" }), false);
    assert.equal(await adapter.detect({ id: "v-4", filename: "calls.bcf", contentString: "binary" }), false);
  });

  test("parses header and variant fields with referenceGenome in envelope metadata", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "v-5", filename: "calls.vcf", contentString: VCF_SAMPLE },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 3);
    assert.equal(envelopes[0].domain, "genomics");
    assert.equal(envelopes[0].source.formatVersion, "VCFv4.2");
    assert.equal(envelopes[0].metadata.referenceGenome, "file:///ref/hg19.fasta");
    assert.equal(envelopes[0].metadata.hasSymbolicAllele, false);
    assert.equal(envelopes[2].metadata.hasSymbolicAllele, true);
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelopes[0].provenance.sourceLocation, "line 10");
    assert.equal(envelopes[1].provenance.sourceLocation, "line 11");

    const first = structuredData(envelopes[0]);
    assert.equal(first.chrom, "chr1");
    assert.equal(first.pos, 10177);
    assert.equal(first.id, "rs367896724");
    assert.deepEqual(first.alt, ["AC"]);
    assert.deepEqual(first.filter, ["PASS"]);
    assert.deepEqual(first.info, { DP: "14", AF: ["0.5", "0.1"], H2: true });

    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("VCF_MALFORMED_LINE"));
    assert.ok(codes.includes("VCF_INVALID_POS"));
  });

  test("preserves symbolic alleles and honours the referenceGenome option", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "v-6", filename: "calls.vcf", contentString: VCF_SAMPLE },
      contextFor(adapter, { referenceGenome: "GRCh38" }),
    );
    assert.deepEqual(structuredData(envelopes[2]).alt, ["<DEL>"]);
    assert.equal(envelopes[2].metadata.referenceGenome, "GRCh38");
    // No clinical interpretation anywhere in the envelope payload.
    const serialised = JSON.stringify(envelopes).toLowerCase();
    assert.ok(!serialised.includes("pathogenic"));
    assert.ok(!serialised.includes("benign"));
  });

  test("inspection reports schema, counts and header summary", async () => {
    const inspection = await adapter.inspect({ id: "v-7", filename: "calls.vcf", contentString: VCF_SAMPLE });
    assert.equal(inspection.domain, "genomics");
    assert.equal(inspection.recordCount, 3);
    assert.equal(inspection.formatVersion, "VCFv4.2");
    assert.equal(inspection.status, "metadata-only");
    assert.ok(inspection.detectedSchema?.fields.some((f) => f.name === "CHROM"));
    assert.ok(inspection.warnings?.some((w) => w.includes("contigs: 2")));
  });

  test("reports health and satisfies the shared conformance contract", async () => {
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    assert.deepEqual(await runAdapterConformance(adapter), []);
  });
});

describe("FASTA/FASTQ adapter", () => {
  const adapter = new FastaFastqFormatAdapter();

  test("manifest is honestly metadata-only and promises bounded previews", () => {
    const manifest = adapter.getManifest();
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.ok(manifest.limitations?.some((l) => l.includes("never embedded")));
  });

  test("detects FASTA/FASTQ by extension and content", async () => {
    assert.equal(await adapter.detect({ id: "s-1", filename: "reads.fa", contentString: FASTA_SAMPLE }), true);
    assert.equal(await adapter.detect({ id: "s-2", filename: "reads.fastq", contentString: FASTQ_SAMPLE }), true);
    assert.equal(await adapter.detect({ id: "s-3", filename: "seq.txt", contentString: FASTA_SAMPLE }), true);
    assert.equal(await adapter.detect({ id: "s-4", filename: "data.csv", contentString: "a,b\n1,2\n" }), false);
  });

  test("parses FASTA metadata with GC, checksums and bounded previews", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "s-5", filename: "reads.fa", contentString: FASTA_SAMPLE },
      contextFor(adapter),
    );
    assert.equal(issues.length, 0);
    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0].domain, "genomics");
    const first = structuredData(envelopes[0]);
    assert.equal(first.recordId, "seq1");
    assert.equal(first.length, 12);
    assert.equal(first.gcFraction, 0.5);
    assert.match(String(first.sequenceChecksum), /^sha256:[a-f0-9]{64}$/);
    assert.ok(String(first.sequencePreview).length <= MAX_PREVIEW_BASES);
    assert.equal(structuredData(envelopes[1]).length, 12);
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
  });

  test("never inlines full sequences into envelopes", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "s-6", filename: "long.fa", contentString: FASTA_LONG },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.ok(!JSON.stringify(envelopes[0]).includes(LONG_SEQ));
    const data = structuredData(envelopes[0]);
    assert.equal(String(data.sequencePreview).length, MAX_PREVIEW_BASES);
    assert.equal(data.sequenceTruncated, true);
  });

  test("parses FASTQ with quality lengths and an honest encoding guess", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "s-7", filename: "reads.fastq", contentString: FASTQ_SAMPLE },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 2);
    const data = structuredData(envelopes[0]);
    assert.equal(data.qualityLength, 8);
    assert.ok(String(data.qualityPreview).length <= MAX_PREVIEW_BASES);
    assert.ok(String(envelopes[0].metadata.qualityEncodingGuess).includes("guessed"));
    const inspection = await adapter.inspect({ id: "s-8", filename: "reads.fastq", contentString: FASTQ_SAMPLE });
    assert.ok(inspection.warnings?.some((w) => w.includes("quality encoding guess")));
  });

  test("reports malformed records via onIssue instead of swallowing them", async () => {
    const fastaResult = await collect(
      adapter,
      { id: "s-9", filename: "bad.fa", contentString: ["ACGT", ">ok", "ACGT"].join("\n") },
      contextFor(adapter),
    );
    assert.equal(fastaResult.envelopes.length, 1);
    assert.ok(fastaResult.issues.some((i) => i.code === "FASTA_SEQUENCE_WITHOUT_HEADER"));

    const fastqResult = await collect(
      adapter,
      { id: "s-10", filename: "bad.fastq", contentString: ["@r1", "ACGT", "+", "II", "@r2", "ACGT"].join("\n") },
      contextFor(adapter),
    );
    assert.ok(
      fastqResult.issues.some((i) => i.code === "FASTQ_LENGTH_MISMATCH" || i.code === "FASTQ_TRUNCATED_RECORD"),
    );

    const unknown = await collect(
      adapter,
      { id: "s-11", filename: "mystery.txt", contentString: "just some prose" },
      contextFor(adapter),
    );
    assert.equal(unknown.envelopes.length, 0);
    assert.ok(unknown.issues.some((i) => i.code === "SEQ_UNRECOGNIZED_FORMAT"));
  });

  test("inspection reports counts and length distribution", async () => {
    const inspection = await adapter.inspect({ id: "s-12", filename: "reads.fa", contentString: FASTA_SAMPLE });
    assert.equal(inspection.domain, "genomics");
    assert.equal(inspection.recordCount, 2);
    assert.equal(inspection.status, "metadata-only");
    assert.ok(inspection.warnings?.some((w) => w.includes("records: 2")));
    assert.ok(inspection.warnings?.some((w) => w.includes("mean GC")));
  });

  test("quality guess helper labels its uncertainty", () => {
    assert.ok(guessQualityEncoding(["IIII"])?.includes("guessed"));
    assert.equal(guessQualityEncoding([]), undefined);
  });

  test("reports health and satisfies the shared conformance contract", async () => {
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    assert.deepEqual(await runAdapterConformance(adapter), []);
  });
});
