export type Shape =
  | { kind: "string" | "boolean" | "float64" | "bytes" | "null" | "dynamic" }
  | { kind: "int64"; semantic?: "commitTimestamp" }
  | { kind: "id"; table: string }
  | { kind: "array"; element: Shape }
  | { kind: "object"; fields: Field[] }
  | { kind: "record"; key: Shape; value: Shape }
  | { kind: "union"; variants: Shape[] }
  | { kind: "literal"; value: string | boolean | number | { $integer: string } }
  | { kind: "tuple"; elements: Shape[] }
  | { kind: "ref"; name: string };

export interface Field {
  name: string;
  type: Shape;
  optional: boolean;
}

export interface ContractFunction {
  path: string;
  module: string[];
  name: string;
  kind: "query" | "mutation" | "action";
  arguments: Extract<Shape, { kind: "object" }>;
  result: Shape;
  typeSource: "inferred" | "validator" | "dynamic";
  source?: { file: string; line: number };
}

export interface Contract {
  formatVersion: 1;
  provenance: {
    exporterVersion: string;
    convexVersion: string;
    typescriptVersion: string;
    sourceHash: string;
  };
  functions: ContractFunction[];
  tables: { name: string; document: Shape }[];
  types: Record<string, Shape>;
}

export interface ExportOptions {
  project: string;
  root?: string;
  allowDynamic?: string[];
}
