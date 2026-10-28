export interface FhirHumanName {
  use?: string;
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
}

export interface FhirIdentifier {
  use?: string;
  system?: string;
  value?: string;
}

export interface FhirCodeableConcept {
  coding?: Array<{
    system?: string;
    code?: string;
    display?: string;
  }>;
  text?: string;
}

export interface FhirReference {
  reference?: string;
  type?: string;
  display?: string;
}

export interface FhirPatient {
  resourceType: "Patient";
  id?: string;
  identifier?: FhirIdentifier[];
  active?: boolean;
  name?: FhirHumanName[];
  gender?: "male" | "female" | "other" | "unknown";
  birthDate?: string;
  address?: Array<{
    use?: string;
    line?: string[];
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }>;
}

export interface FhirObservation {
  resourceType: "Observation";
  id?: string;
  status: "registered" | "preliminary" | "final" | "amended";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  effectiveDateTime?: string;
  valueQuantity?: {
    value?: number;
    unit?: string;
    system?: string;
    code?: string;
  };
  valueString?: string;
  interpretation?: FhirCodeableConcept[];
  specimen?: FhirReference;
}

export interface FhirSpecimen {
  resourceType: "Specimen";
  id?: string;
  identifier?: FhirIdentifier[];
  accessionIdentifier?: FhirIdentifier;
  status?: "available" | "unavailable" | "unsatisfactory" | "entered-in-error";
  type?: FhirCodeableConcept;
  subject?: FhirReference;
  receivedTime?: string;
  collection?: {
    collector?: FhirReference;
    collectedDateTime?: string;
    quantity?: {
      value?: number;
      unit?: string;
    };
  };
}

export interface FhirDiagnosticReport {
  resourceType: "DiagnosticReport";
  id?: string;
  identifier?: FhirIdentifier[];
  status: "registered" | "partial" | "preliminary" | "final";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  result?: FhirReference[];
  specimen?: FhirReference[];
}

export interface FhirOperationOutcome {
  resourceType: "OperationOutcome";
  issue: Array<{
    severity: "fatal" | "error" | "warning" | "information";
    code: string;
    details?: FhirCodeableConcept;
    diagnostics?: string;
    expression?: string[];
  }>;
}
