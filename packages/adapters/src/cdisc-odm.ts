/**
 * CDISC ODM study-metadata adapter — structural metadata only.
 *
 * Status is honestly `metadata-only`: the adapter walks the raw text with a
 * hand-rolled tag scanner (no XML library, no schema validation) and reports
 * Study/OID identity, MetaDataVersion defs (StudyEventDef, FormDef,
 * ItemGroupDef, ItemDef with OID/Name/DataType/CodeList refs), CodeList
 * summaries, and ClinicalData structure (SubjectData/StudyEventData/FormData
 * with subject keys carried verbatim and item values as bounded previews).
 * No clinical interpretation is performed here — no SDTM mapping, no clinical
 * meaning, no NLP, no code translation, no triage or treatment advice.
 *
 * Audit records, annotations and signatures (`<AuditRecords>`,
 * `<Annotations>`, `<Signatures>`) are deliberately skipped: their presence
 * is counted and reported, never parsed into envelopes.
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

export const CDISC_ODM_ADAPTER_ID = "cdisc-odm-adapter";
export const CDISC_ODM_ADAPTER_VERSION = "1.0.0";

/** Characters of an ItemData value kept per envelope (never the whole value). */
export const MAX_ITEM_PREVIEW_CHARS = 200;

/** Characters of a metadata name/question kept per record (never the whole text). */
export const MAX_NAME_PREVIEW_CHARS = 200;

/** Hard cap on scanned tags so a hostile oversized file cannot exhaust memory. */
const MAX_SCANNED_TAGS = 500_000;

export interface OdmStudyEventDef {
  oid: string;
  name?: string;
  type?: string;
  formRefCount: number;
  formOids: string[];
}

export interface OdmFormDef {
  oid: string;
  name?: string;
  itemGroupRefCount: number;
  itemGroupOids: string[];
}

export interface OdmItemGroupDef {
  oid: string;
  name?: string;
  domain?: string;
  itemRefCount: number;
  itemOids: string[];
}

export interface OdmItemDef {
  oid: string;
  name?: string;
  dataType?: string;
  codeListOid?: string;
  measurementUnitOid?: string;
  questionPreview?: string;
}

export interface OdmCodeList {
  oid: string;
  name?: string;
  dataType?: string;
  codedValueCount: number;
  sampleCodedValues: string[];
}

export interface OdmMetaDataVersion {
  oid: string;
  name?: string;
  studyEventDefs: OdmStudyEventDef[];
  formDefs: OdmFormDef[];
  itemGroupDefs: OdmItemGroupDef[];
  itemDefs: OdmItemDef[];
  codeLists: OdmCodeList[];
}

export interface OdmStudy {
  oid: string;
  studyNamePreview?: string;
  studyDescriptionPreview?: string;
  protocolNamePreview?: string;
  metaDataVersions: OdmMetaDataVersion[];
}

export interface OdmClinicalItem {
  itemOid: string;
  itemGroupOid?: string;
  valuePreview: string;
  truncated: boolean;
}

export interface OdmClinicalForm {
  subjectKey: string;
  subjectIndex: number;
  studyEventOid?: string;
  studyEventRepeatKey?: string;
  formOid?: string;
  formRepeatKey?: string;
  items: OdmClinicalItem[];
}

export interface OdmClinicalData {
  studyOid?: string;
  metaDataVersionOid?: string;
  forms: OdmClinicalForm[];
  subjectCount: number;
}

export interface OdmFileMetadata {
  odmVersion?: string;
  fileType?: string;
  fileOid?: string;
  creationDateTime?: string;
  studies: OdmStudy[];
  clinical: OdmClinicalData[];
  skippedBlockCount: number;
  skippedBlockKinds: string[];
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

export interface OdmScanStats {
  elementCount: number;
  attributeCount: number;
  maxDepth: number;
  rootElement?: string;
  rootLocalName?: string;
  namespaces: string[];
  elementCounts: Record<string, number>;
  truncated: boolean;
  unbalanced: boolean;
}

/**
 * Hand-rolled structural scan over raw XML text. No XML library is used on
 * purpose: the adapter reports counts, depth and the root element without
 * ever building a DOM or expanding entities (entities are refused earlier by
 * {@link assertSafeXml}).
 */
export function scanOdmStructure(text: string): OdmScanStats {
  const elementCounts: Record<string, number> = {};
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
    truncated,
    unbalanced,
  };
}

/**
 * True only for CDISC ODM payloads: an `<ODM>` root element plus an ODM
 * namespace marker (or ODM-specific child elements when the namespace is
 * omitted). Generic XML and CDA (`<ClinicalDocument>`) never match, so this
 * adapter never claims non-ODM XML.
 */
export function looksLikeOdm(text: string): boolean {
  const head = text.slice(0, 8192);
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (/"resourceType"\s*:/.test(head)) return false;
  if (!/<(?:\w+:)?ODM[\s>/]/.test(head)) return false;
  if (/cdisc/i.test(head) || /\/odm/i.test(head)) return true;
  return /<(?:\w+:)?(?:Study|MetaDataVersion|ClinicalData|ItemDef|FormDef)\b/.test(head);
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

function firstElementText(text: string, tag: string, maxChars: number = MAX_NAME_PREVIEW_CHARS): string | undefined {
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

interface OdmBlock {
  attrs: Record<string, string>;
  inner: string;
}

function allBlocks(text: string, tag: string): OdmBlock[] {
  const pattern = new RegExp(`<(?:\\w+:)?${tag}\\b([^<>]*)>([\\s\\S]*?)</(?:\\w+:)?${tag}\\s*>`, "gi");
  const found: OdmBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    found.push({ attrs: parseAttributes(match[1]), inner: match[2] });
  }
  return found;
}

function refOids(inner: string, tag: string): string[] {
  const oids: string[] = [];
  for (const attrs of allTagAttributes(inner, tag)) {
    if (attrs.OID) oids.push(attrs.OID);
  }
  return oids;
}

function extractMetaDataVersion(block: OdmBlock): OdmMetaDataVersion {
  const studyEventDefs: OdmStudyEventDef[] = allBlocks(block.inner, "StudyEventDef").map((def) => ({
    oid: def.attrs.OID ?? "",
    name: def.attrs.Name,
    type: def.attrs.Type,
    formRefCount: allTagAttributes(def.inner, "FormRef").length,
    formOids: refOids(def.inner, "FormRef"),
  }));

  const formDefs: OdmFormDef[] = allBlocks(block.inner, "FormDef").map((def) => ({
    oid: def.attrs.OID ?? "",
    name: def.attrs.Name,
    itemGroupRefCount: allTagAttributes(def.inner, "ItemGroupRef").length,
    itemGroupOids: refOids(def.inner, "ItemGroupRef"),
  }));

  const itemGroupDefs: OdmItemGroupDef[] = allBlocks(block.inner, "ItemGroupDef").map((def) => ({
    oid: def.attrs.OID ?? "",
    name: def.attrs.Name,
    domain: def.attrs.Domain,
    itemRefCount: allTagAttributes(def.inner, "ItemRef").length,
    itemOids: refOids(def.inner, "ItemRef"),
  }));

  const itemDefs: OdmItemDef[] = allBlocks(block.inner, "ItemDef").map((def) => {
    const codeListRefs = allTagAttributes(def.inner, "CodeListRef");
    const unitRefs = allTagAttributes(def.inner, "MeasurementUnitRef");
    return {
      oid: def.attrs.OID ?? "",
      name: def.attrs.Name,
      dataType: def.attrs.DataType,
      codeListOid: codeListRefs.length > 0 ? codeListRefs[0].CodeListOID : undefined,
      measurementUnitOid: unitRefs.length > 0 ? unitRefs[0].MeasurementUnitOID : undefined,
      questionPreview: firstElementText(def.inner, "TranslatedText"),
    };
  });

  const codeLists: OdmCodeList[] = allBlocks(block.inner, "CodeList").map((list) => {
    const codedValues: string[] = [];
    for (const attrs of allTagAttributes(list.inner, "CodeListItem")) {
      if (attrs.CodedValue !== undefined) codedValues.push(attrs.CodedValue);
    }
    return {
      oid: list.attrs.OID ?? "",
      name: list.attrs.Name,
      dataType: list.attrs.DataType,
      codedValueCount: codedValues.length,
      sampleCodedValues: codedValues.slice(0, 5).map((value) => value.slice(0, MAX_ITEM_PREVIEW_CHARS)),
    };
  });

  return {
    oid: block.attrs.OID ?? "",
    name: block.attrs.Name,
    studyEventDefs,
    formDefs,
    itemGroupDefs,
    itemDefs,
    codeLists,
  };
}

/** Extract Study identity plus every MetaDataVersion def list — metadata only. */
export function extractOdmStudies(text: string): OdmStudy[] {
  return allBlocks(text, "Study").map((study) => {
    const globals = firstElementInner(study.inner, "GlobalVariables");
    return {
      oid: study.attrs.OID ?? "",
      studyNamePreview: globals === undefined ? undefined : firstElementText(globals, "StudyName"),
      studyDescriptionPreview: globals === undefined ? undefined : firstElementText(globals, "StudyDescription"),
      protocolNamePreview: globals === undefined ? undefined : firstElementText(globals, "ProtocolName"),
      metaDataVersions: allBlocks(study.inner, "MetaDataVersion").map(extractMetaDataVersion),
    };
  });
}

function boundPreview(value: string): { preview: string; truncated: boolean } {
  if (value.length > MAX_ITEM_PREVIEW_CHARS) {
    return { preview: value.slice(0, MAX_ITEM_PREVIEW_CHARS), truncated: true };
  }
  return { preview: value, truncated: false };
}

/**
 * Extract ClinicalData structure: one flattened record per FormData, with
 * subject keys carried verbatim and item values as bounded previews that are
 * never interpreted, coded or mapped.
 */
export function extractOdmClinical(text: string): OdmClinicalData[] {
  return allBlocks(text, "ClinicalData").map((clinical) => {
    const forms: OdmClinicalForm[] = [];
    const subjectBlocks = allBlocks(clinical.inner, "SubjectData");
    subjectBlocks.forEach((subject, subjectIndex) => {
      // SubjectKey is carried verbatim — never normalised or interpreted.
      const subjectKey = subject.attrs.SubjectKey ?? "";
      for (const event of allBlocks(subject.inner, "StudyEventData")) {
        for (const form of allBlocks(event.inner, "FormData")) {
          const items: OdmClinicalItem[] = [];
          const groupBlocks = allBlocks(form.inner, "ItemGroupData");
          const groups = groupBlocks.length > 0 ? groupBlocks : [{ attrs: {}, inner: form.inner }];
          for (const group of groups) {
            for (const attrs of allTagAttributes(group.inner, "ItemData")) {
              if (attrs.ItemOID === undefined) continue;
              const raw = attrs.Value ?? "";
              const { preview, truncated } = boundPreview(raw);
              items.push({
                itemOid: attrs.ItemOID,
                itemGroupOid: group.attrs.ItemGroupOID,
                valuePreview: preview,
                truncated,
              });
            }
          }
          forms.push({
            subjectKey,
            subjectIndex,
            studyEventOid: event.attrs.StudyEventOID,
            studyEventRepeatKey: event.attrs.StudyEventRepeatKey,
            formOid: form.attrs.FormOID,
            formRepeatKey: form.attrs.FormRepeatKey,
            items,
          });
        }
      }
    });
    return {
      studyOid: clinical.attrs.StudyOID,
      metaDataVersionOid: clinical.attrs.MetaDataVersionOID,
      forms,
      subjectCount: subjectBlocks.length,
    };
  });
}

const SKIPPED_BLOCK_TAGS = ["AuditRecords", "Annotations", "Signatures"];

/** Count deliberately skipped top-level blocks (audit, annotations, signatures). */
export function countSkippedOdmBlocks(text: string): { count: number; kinds: string[] } {
  const kinds: string[] = [];
  let count = 0;
  for (const tag of SKIPPED_BLOCK_TAGS) {
    const pattern = new RegExp(`<(?:\\w+:)?${tag}[\\s>/]`, "g");
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      count += matches.length;
      kinds.push(tag);
    }
  }
  return { count, kinds };
}

/** Aggregate every ODM metadata section in one structural pass. */
export function extractOdmMetadata(text: string): OdmFileMetadata {
  const rootAttrs = firstTagAttributes(text, "ODM") ?? {};
  const studies = extractOdmStudies(text);
  const clinical = extractOdmClinical(text);
  const skipped = countSkippedOdmBlocks(text);
  return {
    odmVersion: rootAttrs.ODMVersion,
    fileType: rootAttrs.FileType,
    fileOid: rootAttrs.FileOID,
    creationDateTime: rootAttrs.CreationDateTime,
    studies,
    clinical,
    skippedBlockCount: skipped.count,
    skippedBlockKinds: skipped.kinds,
  };
}

function countDefs(studies: OdmStudy[]): {
  studyEventDefCount: number;
  formDefCount: number;
  itemGroupDefCount: number;
  itemDefCount: number;
  codeListCount: number;
  formDefs: OdmFormDef[];
  studyOid?: string;
  metaDataVersionOid?: string;
} {
  let studyEventDefCount = 0;
  let formDefCount = 0;
  let itemGroupDefCount = 0;
  let itemDefCount = 0;
  let codeListCount = 0;
  const formDefs: OdmFormDef[] = [];
  for (const study of studies) {
    for (const version of study.metaDataVersions) {
      studyEventDefCount += version.studyEventDefs.length;
      formDefCount += version.formDefs.length;
      itemGroupDefCount += version.itemGroupDefs.length;
      itemDefCount += version.itemDefs.length;
      codeListCount += version.codeLists.length;
      formDefs.push(...version.formDefs);
    }
  }
  return {
    studyEventDefCount,
    formDefCount,
    itemGroupDefCount,
    itemDefCount,
    codeListCount,
    formDefs,
    studyOid: studies.length > 0 ? studies[0].oid : undefined,
    metaDataVersionOid:
      studies.length > 0 && studies[0].metaDataVersions.length > 0 ? studies[0].metaDataVersions[0].oid : undefined,
  };
}

function flattenClinicalForms(clinical: OdmClinicalData[]): OdmClinicalForm[] {
  return clinical.flatMap((block) => block.forms);
}

function describeLimitations(): string[] {
  return [
    "Structural metadata only: Study/OID identity, MetaDataVersion defs (OID, Name, DataType, CodeList refs) and ClinicalData structure.",
    "Subject keys are carried verbatim; item values are bounded previews and are never interpreted, coded or mapped.",
    "No SDTM mapping: ODM defs are not translated to SDTM domains.",
    "No clinical meaning is inferred (no diagnoses, triage or treatment advice).",
    "No clinical NLP: free-text values are reported as bounded previews, never coded.",
    "No XML schema (XSD) validation against CDISC ODM schemas.",
    "Audit records, annotations and signatures are skipped and reported as skipped, never parsed.",
  ];
}

function odmDomain(): MedicalDomain {
  return "research";
}

export class CdiscOdmFormatAdapter implements MedicalFormatAdapter {
  public id = CDISC_ODM_ADAPTER_ID;
  public version = CDISC_ODM_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "cdisc-odm",
      version: CDISC_ODM_ADAPTER_VERSION,
      description:
        "CDISC ODM study metadata adapter (hand-rolled tag scan, no XML dependency, no SDTM mapping, no clinical interpretation)",
      extensions: [".xml", ".odm"],
      mimeTypes: ["application/xml", "text/xml"],
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
      if (!looksLikeOdm(text)) return 0;

      const ext = fileExtension(input);
      if (ext === "odm") return 0.95;
      if (ext === "xml") return 0.9;
      if (input.mimeType && /odm|cdisc/i.test(input.mimeType)) return 0.9;
      if (input.mimeType && /xml/i.test(input.mimeType)) return 0.85;
      return 0.8;
    } catch {
      return 0;
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding, warnings } = readInputText(input);
    assertSafeXml(text);
    if (text.trim() === "") {
      return {
        format: "cdisc-odm",
        domain: "unknown",
        recordCount: 0,
        capabilities: this.getManifest().capabilities,
        status: this.getManifest().status,
        warnings: [...warnings, "Empty input: no ODM document found"],
      };
    }

    const stats = scanOdmStructure(text);
    if (stats.rootLocalName !== "ODM") {
      return {
        format: "cdisc-odm",
        domain: "unknown",
        recordCount: 0,
        capabilities: this.getManifest().capabilities,
        status: this.getManifest().status,
        warnings: [...warnings, `Not an ODM document: root element is <${stats.rootElement ?? "?"}>, expected <ODM>`],
      };
    }

    const metadata = extractOdmMetadata(text);
    const defs = countDefs(metadata.studies);
    const forms = flattenClinicalForms(metadata.clinical);
    const itemDataCount = forms.reduce((sum, form) => sum + form.items.length, 0);
    const subjectCount = metadata.clinical.reduce((sum, block) => sum + block.subjectCount, 0);
    const recordCount = forms.length > 0 ? forms.length : defs.formDefCount > 0 ? defs.formDefCount : 1;
    const formatVersion = metadata.odmVersion ?? "odm";

    const sampleRecords: Array<Record<string, unknown>> =
      forms.length > 0
        ? forms.slice(0, 5).map((form) => ({
            subjectKey: form.subjectKey,
            studyEventOid: form.studyEventOid ?? null,
            formOid: form.formOid ?? null,
            itemCount: form.items.length,
            items: form.items.slice(0, 10).map((item) => ({
              itemOid: item.itemOid,
              itemGroupOid: item.itemGroupOid ?? null,
              valuePreview: item.valuePreview,
              truncated: item.truncated,
            })),
          }))
        : defs.formDefs.slice(0, 5).map((form) => ({
            formOid: form.oid,
            formName: form.name ?? null,
            itemGroupRefCount: form.itemGroupRefCount,
            itemGroupOids: form.itemGroupOids,
          }));

    return {
      format: "cdisc-odm",
      formatVersion,
      domain: odmDomain(),
      recordCount,
      detectedSchema: {
        fields: [
          { name: "Study", type: "def", sampleValues: [metadata.studies.length], nullable: false },
          {
            name: "MetaDataVersion",
            type: "def",
            sampleValues: [metadata.studies.reduce((sum, s) => sum + s.metaDataVersions.length, 0)],
            nullable: false,
          },
          { name: "StudyEventDef", type: "def", sampleValues: [defs.studyEventDefCount], nullable: false },
          { name: "FormDef", type: "def", sampleValues: [defs.formDefCount], nullable: false },
          { name: "ItemGroupDef", type: "def", sampleValues: [defs.itemGroupDefCount], nullable: false },
          { name: "ItemDef", type: "def", sampleValues: [defs.itemDefCount], nullable: false },
          { name: "CodeList", type: "def", sampleValues: [defs.codeListCount], nullable: false },
          { name: "SubjectData", type: "clinical", sampleValues: [subjectCount], nullable: false },
          { name: "FormData", type: "clinical", sampleValues: [forms.length], nullable: false },
          { name: "ItemData", type: "clinical", sampleValues: [itemDataCount], nullable: false },
        ],
      },
      sampleRecords,
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        ...warnings,
        `Encoding: ${encoding}`,
        `ODM version: ${formatVersion}${metadata.fileType ? `, FileType: ${metadata.fileType}` : ""}`,
        `Studies: ${metadata.studies.length}${defs.studyOid ? ` (OID: ${defs.studyOid})` : ""}`,
        `MetaDataVersion: ${defs.metaDataVersionOid ?? "none"}`,
        `Defs: ${defs.studyEventDefCount} StudyEventDef, ${defs.formDefCount} FormDef, ${defs.itemGroupDefCount} ItemGroupDef, ${defs.itemDefCount} ItemDef, ${defs.codeListCount} CodeList`,
        `Clinical: ${subjectCount} SubjectData, ${forms.length} FormData, ${itemDataCount} ItemData`,
        ...(metadata.skippedBlockCount > 0
          ? [
              `Skipped ${metadata.skippedBlockCount} block(s) (${metadata.skippedBlockKinds.join(", ")}): audit/annotations skipped by design`,
            ]
          : []),
        ...(stats.truncated ? ["Tag scan hit the safety cap; counts are lower bounds"] : []),
        ...(stats.unbalanced ? ["Unbalanced or mismatched tags detected; structure reported as scanned"] : []),
        "Metadata-only: no SDTM mapping, no clinical meaning, no NLP, no schema validation.",
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding } = readInputText(input);
    assertSafeXml(text);
    if (text.trim() === "") {
      context.onIssue?.({
        code: "ODM_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable text; nothing was parsed",
      });
      return;
    }

    const stats = scanOdmStructure(text);
    if (!stats.rootElement) {
      context.onIssue?.({
        code: "ODM_NO_ROOT_ELEMENT",
        severity: "error",
        message: "No XML root element found; nothing was parsed",
      });
      return;
    }
    if (stats.rootLocalName !== "ODM") {
      context.onIssue?.({
        code: "ODM_NOT_ODM_DOCUMENT",
        severity: "error",
        message: `Root element is <${stats.rootElement}>, not <ODM>; nothing was parsed`,
      });
      return;
    }
    if (stats.truncated) {
      context.onIssue?.({
        code: "ODM_TRUNCATED_SCAN",
        severity: "warning",
        message: "Tag scan hit the safety cap; element counts are lower bounds",
      });
    }
    if (stats.unbalanced) {
      context.onIssue?.({
        code: "ODM_UNBALANCED_TAGS",
        severity: "warning",
        message: "Mismatched or unclosed tags detected; structure reported as scanned",
      });
    }

    const metadata = extractOdmMetadata(text);
    if (metadata.skippedBlockCount > 0) {
      context.onIssue?.({
        code: "ODM_SKIPPED_BLOCKS",
        severity: "information",
        message: `Skipped ${metadata.skippedBlockCount} block(s) (${metadata.skippedBlockKinds.join(", ")}): audit/annotations skipped by design`,
      });
    }

    const checksum = computeChecksum(input);
    const formatVersion = metadata.odmVersion ?? "odm";
    const defs = countDefs(metadata.studies);
    const forms = flattenClinicalForms(metadata.clinical);
    const limit = context.maxRecords ?? Number.MAX_SAFE_INTEGER;

    if (forms.length > 0) {
      let recordIndex = 0;
      for (const form of forms) {
        if (recordIndex >= limit) return;
        yield createCanonicalEnvelope({
          id: `odm-form-${recordIndex}`,
          domain: odmDomain(),
          sourceFormat: "cdisc-odm",
          formatVersion,
          content: {
            kind: "structured",
            data: {
              recordKind: "odm-clinical-form",
              studyOid: defs.studyOid ?? null,
              metaDataVersionOid: defs.metaDataVersionOid ?? null,
              subjectKey: form.subjectKey,
              studyEventOid: form.studyEventOid ?? null,
              studyEventRepeatKey: form.studyEventRepeatKey ?? null,
              formOid: form.formOid ?? null,
              formRepeatKey: form.formRepeatKey ?? null,
              itemCount: form.items.length,
              items: form.items.map((item) => ({
                itemOid: item.itemOid,
                itemGroupOid: item.itemGroupOid ?? null,
                valuePreview: item.valuePreview,
                truncated: item.truncated,
              })),
            },
          },
          importedAt: context.importedAt,
          adapterId: this.id,
          adapterVersion: this.version,
          recordIndex,
          sourceLocation: `subject ${form.subjectKey} / ${form.studyEventOid ?? "?"} / ${form.formOid ?? "?"}`,
          filename: input.filename,
          checksum,
          encoding,
          metadata: {
            studyOid: defs.studyOid,
            metaDataVersionOid: defs.metaDataVersionOid,
            subjectKey: form.subjectKey,
            subjectIndex: form.subjectIndex,
            studyEventOid: form.studyEventOid,
            formOid: form.formOid,
            itemCount: form.items.length,
            odmVersion: formatVersion,
            fileType: metadata.fileType,
            skippedBlocks: metadata.skippedBlockCount,
          },
        });
        recordIndex++;
      }
      return;
    }

    if (defs.formDefCount > 0) {
      let recordIndex = 0;
      for (const study of metadata.studies) {
        for (const version of study.metaDataVersions) {
          for (const form of version.formDefs) {
            if (recordIndex >= limit) return;
            yield createCanonicalEnvelope({
              id: `odm-formdef-${recordIndex}`,
              domain: odmDomain(),
              sourceFormat: "cdisc-odm",
              formatVersion,
              content: {
                kind: "structured",
                data: {
                  recordKind: "odm-form-def",
                  studyOid: study.oid,
                  metaDataVersionOid: version.oid,
                  formOid: form.oid,
                  formName: form.name ?? null,
                  itemGroupRefCount: form.itemGroupRefCount,
                  itemGroupOids: form.itemGroupOids,
                },
              },
              importedAt: context.importedAt,
              adapterId: this.id,
              adapterVersion: this.version,
              recordIndex,
              sourceLocation: `FormDef ${form.oid}`,
              filename: input.filename,
              checksum,
              encoding,
              metadata: {
                studyOid: study.oid,
                metaDataVersionOid: version.oid,
                formOid: form.oid,
                odmVersion: formatVersion,
                skippedBlocks: metadata.skippedBlockCount,
              },
            });
            recordIndex++;
          }
        }
      }
      return;
    }

    if (limit < 1) return;
    yield createCanonicalEnvelope({
      id: "odm-study-summary-0",
      domain: odmDomain(),
      sourceFormat: "cdisc-odm",
      formatVersion,
      content: {
        kind: "structured",
        data: {
          recordKind: "odm-study-summary",
          studyCount: metadata.studies.length,
          studyOids: metadata.studies.map((study) => study.oid),
          studyEventDefCount: defs.studyEventDefCount,
          formDefCount: defs.formDefCount,
          itemGroupDefCount: defs.itemGroupDefCount,
          itemDefCount: defs.itemDefCount,
          codeListCount: defs.codeListCount,
          elementCount: stats.elementCount,
          namespaces: stats.namespaces,
        },
      },
      importedAt: context.importedAt,
      adapterId: this.id,
      adapterVersion: this.version,
      recordIndex: 0,
      sourceLocation: "root",
      filename: input.filename,
      checksum,
      encoding,
      metadata: {
        studyOids: metadata.studies.map((study) => study.oid),
        odmVersion: formatVersion,
        fileType: metadata.fileType,
        elementCount: stats.elementCount,
        skippedBlocks: metadata.skippedBlockCount,
      },
    });
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${CDISC_ODM_ADAPTER_ID} ${CDISC_ODM_ADAPTER_VERSION} (structural metadata only; no SDTM mapping, no clinical meaning, no NLP, no schema validation)`,
    };
  }
}
