/**
 * Generic XML / CDA metadata adapter — structural metadata only.
 *
 * Status is honestly `metadata-only`: the adapter walks the raw text with a
 * hand-rolled tag scanner (no XML library, no schema validation) and reports
 * document type guesses, CDA header/section metadata, element/attribute counts
 * and depth. No clinical interpretation is performed here — no NLP, no code
 * translation, no triage or treatment advice.
 *
 * Security: {@link assertSafeXml} from `./kit.js` is the entry gate of both
 * `inspect` and `parse`, so `DOCTYPE`/`ENTITY` payloads (XXE / entity
 * expansion) are refused before any scanning runs. `detect`/`score` never
 * throw: unsafe payloads simply score 0.
 */

import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  MedicalDomain,
  ParseContext,
} from "@healthbridge/shared-types";
import { MedicalFormatAdapter, computeChecksum, createCanonicalEnvelope } from "@healthbridge/core";
import { decodeBuffer } from "./csv.js";
import { assertSafeXml } from "./kit.js";

export const XML_CDA_ADAPTER_ID = "xml-cda-adapter";
export const XML_CDA_ADAPTER_VERSION = "1.0.0";

/** Characters of stripped element text kept per section preview (never the whole document). */
export const MAX_SECTION_PREVIEW_CHARS = 500;

/** Hard cap on scanned tags so a hostile oversized file cannot exhaust memory. */
const MAX_SCANNED_TAGS = 500_000;

export type XmlDocumentType = "cda" | "generic-xml";

export interface XmlCdaHeader {
  templateIds: string[];
  code?: string;
  codeSystem?: string;
  displayName?: string;
  title?: string;
  effectiveTime?: string;
  patientIds: Array<{ root?: string; extension?: string }>;
  authorIds: Array<{ root?: string; extension?: string }>;
  organizationName?: string;
}

export interface XmlCdaSection {
  index: number;
  title?: string;
  code?: string;
  codeSystem?: string;
  displayName?: string;
  textPreview: string;
  elementCount: number;
}

export interface XmlScanStats {
  elementCount: number;
  attributeCount: number;
  maxDepth: number;
  rootElement?: string;
  rootLocalName?: string;
  namespaces: string[];
  elementCounts: Record<string, number>;
  attributeNames: string[];
  truncated: boolean;
  unbalanced: boolean;
}

function readInputText(input: InputDescriptor): { text: string; encoding: string; warnings: string[] } {
  if (input.contentString !== undefined) {
    const text = input.contentString.charCodeAt(0) === 0xfeff ? input.contentString.slice(1) : input.contentString;
    return { text, encoding: "utf-8", warnings: [] };
  }
  if (input.buffer) return decodeBuffer(input.buffer);
  return { text: "", encoding: "utf-8", warnings: ["Input has neither contentString nor buffer"] };
}

function fileExtension(input: InputDescriptor): string {
  if (input.extension) return input.extension.replace(/^\./, "").toLowerCase();
  const name = input.filename ?? input.uri ?? "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function localNameOf(tagName: string): string {
  const cut = tagName.split(":");
  return cut[cut.length - 1];
}

function parseAttributes(attrText: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(attrText)) !== null) {
    const raw = match[2];
    attributes[match[1]] = raw.slice(1, -1);
  }
  return attributes;
}

const TAG_PATTERN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)\s*([A-Za-z_][\w:.-]*)([^<>]*?)(\/?)\s*>/g;

/**
 * Hand-rolled structural scan over raw XML text. No XML library is used on
 * purpose: the adapter reports counts, depth and the root element without ever
 * building a DOM or expanding entities (entities are refused earlier by
 * {@link assertSafeXml}).
 */
export function scanXmlStructure(text: string): XmlScanStats {
  const elementCounts: Record<string, number> = {};
  const attributeSeen = new Set<string>();
  const namespaceSeen = new Set<string>();
  const stack: string[] = [];
  let elementCount = 0;
  let attributeCount = 0;
  let maxDepth = 0;
  let rootElement: string | undefined;
  let truncated = false;
  let unbalanced = false;
  let scannedTags = 0;

  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(text)) !== null) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<![")) continue;
    scannedTags++;
    if (scannedTags > MAX_SCANNED_TAGS) {
      truncated = true;
      break;
    }
    const isClose = match[1] === "/";
    const name = match[2];
    const attrText = match[3] ?? "";
    const isSelfClosing = match[4] === "/";

    if (isClose) {
      const top = stack.lastIndexOf(name);
      if (top === -1) {
        unbalanced = true;
      } else {
        if (top !== stack.length - 1) unbalanced = true;
        stack.length = top;
      }
      continue;
    }

    elementCount++;
    elementCounts[name] = (elementCounts[name] ?? 0) + 1;
    if (rootElement === undefined) rootElement = name;

    const attributes = parseAttributes(attrText);
    for (const [key, value] of Object.entries(attributes)) {
      attributeCount++;
      attributeSeen.add(key);
      if (key === "xmlns" || key.startsWith("xmlns:")) namespaceSeen.add(value);
    }

    if (!isSelfClosing) {
      stack.push(name);
      if (stack.length > maxDepth) maxDepth = stack.length;
    } else if (stack.length + 1 > maxDepth) {
      maxDepth = stack.length + 1;
    }
  }
  if (stack.length > 0) unbalanced = true;

  return {
    elementCount,
    attributeCount,
    maxDepth,
    rootElement,
    rootLocalName: rootElement === undefined ? undefined : localNameOf(rootElement),
    namespaces: [...namespaceSeen].sort(),
    elementCounts,
    attributeNames: [...attributeSeen].sort(),
    truncated,
    unbalanced,
  };
}

function declaredEncoding(text: string, fallback: string): string {
  const match = /<\?xml\b[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(text.slice(0, 1024));
  return match ? match[1] : fallback;
}

/** True when the text carries XML-shaped markup (and is not JSON/FHIR). */
export function looksLikeXml(text: string): boolean {
  const head = text.slice(0, 4096);
  if (!head.includes("<") || !head.includes(">")) return false;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (/"resourceType"\s*:/.test(head)) return false;
  if (/^<\?xml\b/i.test(trimmed)) return true;
  if (/<ClinicalDocument[\s>/]/i.test(head)) return true;
  return /<[A-Za-z_][\w:.-]*(\s[^<>]*)?\/?>/.test(head) && /<\/[A-Za-z_][\w:.-]*\s*>/.test(text);
}

export function guessDocumentType(stats: XmlScanStats): XmlDocumentType {
  if (stats.rootLocalName === "ClinicalDocument") return "cda";
  if (stats.namespaces.some((ns) => /hl7\.org/i.test(ns) || /\/cda/i.test(ns) || /^cda$/i.test(ns))) return "cda";
  return "generic-xml";
}

function stripTags(fragment: string): string {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^<>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstElementInner(text: string, tag: string): string | undefined {
  const pattern = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}\\s*>`, "i");
  const match = pattern.exec(text);
  return match ? match[1] : undefined;
}

function firstElementText(text: string, tag: string, maxChars = 200): string | undefined {
  const inner = firstElementInner(text, tag);
  if (inner === undefined) return undefined;
  const stripped = stripTags(inner);
  return stripped === "" ? undefined : stripped.slice(0, maxChars);
}

function firstTagAttributes(text: string, tag: string): Record<string, string> | undefined {
  const pattern = new RegExp(`<(?:\\w+:)?${tag}\\b([^<>]*?)\\/?>`, "i");
  const match = pattern.exec(text);
  return match ? parseAttributes(match[1]) : undefined;
}

function allTagAttributes(text: string, tag: string): Array<Record<string, string>> {
  const pattern = new RegExp(`<(?:\\w+:)?${tag}\\b([^<>]*?)\\/?>`, "gi");
  const found: Array<Record<string, string>> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.push(parseAttributes(match[1]));
  return found;
}

function blockInner(text: string, tag: string): string | undefined {
  return firstElementInner(text, tag);
}

/** Extract CDA header fields as structural values — no clinical interpretation. */
export function extractCdaHeader(text: string): XmlCdaHeader {
  const templateIds: string[] = [];
  for (const attrs of allTagAttributes(text, "templateId")) {
    if (attrs.root) templateIds.push(attrs.root);
  }

  const codeAttrs = firstTagAttributes(text, "code");
  const effectiveAttrs = firstTagAttributes(text, "effectiveTime");

  const recordTarget = blockInner(text, "recordTarget");
  const patientRole = recordTarget === undefined ? undefined : blockInner(recordTarget, "patientRole");
  const patientIds =
    patientRole === undefined
      ? []
      : allTagAttributes(patientRole, "id").map((attrs) => ({ root: attrs.root, extension: attrs.extension }));

  const author = blockInner(text, "author");
  const assignedAuthor = author === undefined ? undefined : blockInner(author, "assignedAuthor");
  const authorIds =
    assignedAuthor === undefined
      ? []
      : allTagAttributes(assignedAuthor, "id").map((attrs) => ({ root: attrs.root, extension: attrs.extension }));
  const organization = assignedAuthor === undefined ? undefined : blockInner(assignedAuthor, "organization");

  return {
    templateIds,
    code: codeAttrs?.code,
    codeSystem: codeAttrs?.codeSystem,
    displayName: codeAttrs?.displayName,
    title: firstElementText(text, "title"),
    effectiveTime: effectiveAttrs?.value,
    patientIds,
    authorIds,
    organizationName: organization === undefined ? undefined : firstElementText(organization, "name"),
  };
}

/** One structural record per `<section>` block; text is a bounded preview. */
export function extractSections(text: string): XmlCdaSection[] {
  const sections: XmlCdaSection[] = [];
  const pattern = /<(?:\w+:)?section\b([^<>]*?)>([\s\S]*?)<\/(?:\w+:)?section\s*>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    const inner = match[2];
    const codeAttrs = firstTagAttributes(inner, "code");
    const stripped = stripTags(inner);
    const elementMatches = inner.match(/<[A-Za-z_][\w:.-]*/g);
    sections.push({
      index,
      title: firstElementText(inner, "title"),
      code: codeAttrs?.code,
      codeSystem: codeAttrs?.codeSystem,
      displayName: codeAttrs?.displayName,
      textPreview: stripped.slice(0, MAX_SECTION_PREVIEW_CHARS),
      elementCount: elementMatches ? elementMatches.length : 0,
    });
    index++;
  }
  return sections;
}

function describeLimitations(): string[] {
  return [
    "Structural metadata only: element/attribute counts, depth, CDA header and section structure.",
    "No clinical interpretation is performed (no diagnoses, triage or treatment advice).",
    "No clinical NLP: free-text narratives are reported as bounded previews, never coded.",
    "No XML schema (XSD) validation against CDA implementation guides.",
  ];
}

function xmlDomain(documentType: XmlDocumentType): MedicalDomain {
  return documentType === "cda" ? "clinical" : "unknown";
}

export class XmlCdaFormatAdapter implements MedicalFormatAdapter {
  public id = XML_CDA_ADAPTER_ID;
  public version = XML_CDA_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "xml-cda",
      version: XML_CDA_ADAPTER_VERSION,
      description: "Generic XML and HL7 CDA metadata adapter (structural scan, no XML dependency, no clinical NLP)",
      extensions: [".xml", ".cda"],
      mimeTypes: ["application/xml", "text/xml", "application/hl7-cda+xml"],
      status: "metadata-only",
      limitations: describeLimitations(),
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
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  public async score(input: InputDescriptor): Promise<number> {
    try {
      const text = input.contentString ?? "";
      if (text === "") return 0;
      try {
        assertSafeXml(text);
      } catch {
        return 0;
      }
      if (!looksLikeXml(text)) return 0;

      const ext = fileExtension(input);
      if (ext === "xml" || ext === "cda") return 0.9;
      if (input.mimeType && /xml|cda/i.test(input.mimeType)) return 0.85;
      if (/<ClinicalDocument[\s>/]/i.test(text.slice(0, 4096))) return 0.85;
      if (/^<\?xml\b/i.test(text.trimStart())) return 0.8;
      return 0.6;
    } catch {
      return 0;
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding, warnings } = readInputText(input);
    assertSafeXml(text);
    if (text.trim() === "") {
      return {
        format: "xml-cda",
        domain: "unknown",
        recordCount: 0,
        capabilities: this.getManifest().capabilities,
        status: this.getManifest().status,
        warnings: [...warnings, "Empty input: no XML document found"],
      };
    }

    const stats = scanXmlStructure(text);
    const resolvedEncoding = declaredEncoding(text, encoding);
    const documentType = guessDocumentType(stats);
    const sections = documentType === "cda" ? extractSections(text) : [];
    const header = documentType === "cda" ? extractCdaHeader(text) : undefined;
    const domain = xmlDomain(documentType);

    const topElements = Object.entries(stats.elementCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20);

    const sampleRecords: Array<Record<string, unknown>> =
      sections.length > 0
        ? sections.slice(0, 5).map((section) => ({
            sectionIndex: section.index,
            title: section.title ?? null,
            code: section.code ?? null,
            codeSystem: section.codeSystem ?? null,
            textPreview: section.textPreview,
            elementCount: section.elementCount,
          }))
        : [
            {
              documentType,
              rootElement: stats.rootElement ?? null,
              elementCount: stats.elementCount,
              attributeCount: stats.attributeCount,
              maxDepth: stats.maxDepth,
            },
          ];

    return {
      format: "xml-cda",
      formatVersion: documentType === "cda" ? "cda" : "xml-1.0",
      domain,
      recordCount: sections.length > 0 ? sections.length : 1,
      detectedSchema: {
        fields: topElements.map(([name, count]) => ({
          name,
          type: "element",
          sampleValues: [count],
          nullable: false,
        })),
      },
      sampleRecords,
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        ...warnings,
        `Encoding: ${resolvedEncoding}`,
        `Document type: ${documentType} (root <${stats.rootElement ?? "?"}>)`,
        `Elements: ${stats.elementCount}, attributes: ${stats.attributeCount}, max depth: ${stats.maxDepth}`,
        ...(stats.namespaces.length > 0 ? [`Namespaces: ${stats.namespaces.slice(0, 5).join(", ")}`] : []),
        ...(header
          ? [`CDA templateIds: ${header.templateIds.length > 0 ? header.templateIds.join(", ") : "none"}`]
          : []),
        ...(sections.length > 0 ? [`Sections: ${sections.length}`] : ["Sections: none (single document record)"]),
        ...(stats.truncated ? ["Tag scan hit the safety cap; counts are lower bounds"] : []),
        ...(stats.unbalanced ? ["Unbalanced or mismatched tags detected; structure reported as scanned"] : []),
        "Metadata-only: no clinical interpretation, no NLP, no schema validation.",
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding } = readInputText(input);
    assertSafeXml(text);
    if (text.trim() === "") {
      context.onIssue?.({
        code: "XML_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable text; nothing was parsed",
      });
      return;
    }

    const stats = scanXmlStructure(text);
    if (!stats.rootElement) {
      context.onIssue?.({
        code: "XML_NO_ROOT_ELEMENT",
        severity: "error",
        message: "No XML root element found; nothing was parsed",
      });
      return;
    }
    if (stats.truncated) {
      context.onIssue?.({
        code: "XML_TRUNCATED_SCAN",
        severity: "warning",
        message: "Tag scan hit the safety cap; element counts are lower bounds",
      });
    }
    if (stats.unbalanced) {
      context.onIssue?.({
        code: "XML_UNBALANCED_TAGS",
        severity: "warning",
        message: "Mismatched or unclosed tags detected; structure reported as scanned",
      });
    }

    const resolvedEncoding = declaredEncoding(text, encoding);
    const documentType = guessDocumentType(stats);
    const domain = xmlDomain(documentType);
    const formatVersion = documentType === "cda" ? "cda" : "xml-1.0";
    const header = documentType === "cda" ? extractCdaHeader(text) : undefined;
    const sections = documentType === "cda" ? extractSections(text) : [];
    const checksum = computeChecksum(input);
    const limit = context.maxRecords ?? Number.MAX_SAFE_INTEGER;

    if (sections.length === 0) {
      if (limit < 1) return;
      yield createCanonicalEnvelope({
        id: documentType === "cda" ? "cda-document-0" : "xml-doc-0",
        domain,
        sourceFormat: "xml-cda",
        formatVersion,
        content: {
          kind: "structured",
          data: {
            documentType,
            rootElement: stats.rootElement,
            namespaces: stats.namespaces,
            elementCount: stats.elementCount,
            attributeCount: stats.attributeCount,
            maxDepth: stats.maxDepth,
            elementCounts: stats.elementCounts,
            header: header ?? null,
            sectionCount: 0,
          },
        },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: 0,
        sourceLocation: "root",
        filename: input.filename,
        checksum,
        encoding: resolvedEncoding,
        metadata: {
          documentType,
          rootElement: stats.rootElement,
          encoding: resolvedEncoding,
          elementCount: stats.elementCount,
          attributeCount: stats.attributeCount,
          maxDepth: stats.maxDepth,
          sectionCount: 0,
          ...(header ? { templateIds: header.templateIds } : {}),
        },
      });
      return;
    }

    let recordIndex = 0;
    for (const section of sections) {
      if (recordIndex >= limit) return;
      yield createCanonicalEnvelope({
        id: `cda-section-${recordIndex}`,
        domain,
        sourceFormat: "xml-cda",
        formatVersion,
        content: {
          kind: "structured",
          data: {
            documentType,
            rootElement: stats.rootElement,
            sectionIndex: section.index,
            sectionCount: sections.length,
            title: section.title ?? null,
            code: section.code ?? null,
            codeSystem: section.codeSystem ?? null,
            displayName: section.displayName ?? null,
            textPreview: section.textPreview,
            sectionElementCount: section.elementCount,
            documentElementCount: stats.elementCount,
            documentAttributeCount: stats.attributeCount,
            documentMaxDepth: stats.maxDepth,
          },
        },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex,
        sourceLocation: `section ${section.index + 1}`,
        filename: input.filename,
        checksum,
        encoding: resolvedEncoding,
        metadata: {
          documentType,
          rootElement: stats.rootElement,
          encoding: resolvedEncoding,
          elementCount: stats.elementCount,
          attributeCount: stats.attributeCount,
          maxDepth: stats.maxDepth,
          sectionCount: sections.length,
          sectionIndex: section.index,
          templateIds: header?.templateIds ?? [],
          effectiveTime: header?.effectiveTime,
        },
      });
      recordIndex++;
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${XML_CDA_ADAPTER_ID} ${XML_CDA_ADAPTER_VERSION} (structural metadata only; no clinical interpretation, NLP or schema validation)`,
    };
  }
}
