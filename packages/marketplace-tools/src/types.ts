/**
 * Core tool contract — the framework-neutral source of truth.
 *
 * A {@link MarketplaceTool} is a self-describing unit: a stable `name`, a
 * JSON-Schema `inputSchema`, a human/agent-readable `description`, and an async
 * `handler(args, ctx)`. The SCHEMA is the single source of truth; the framework
 * adapters ({@link ../adapters} `toOpenAITools` / `toLangChainTools` /
 * `toCrewAITools`) are thin shape-transforms over the same registry — they never
 * fork the schema.
 *
 * @module types
 */
import type { Address } from "@solana/kit";
import type {
  ProgramAccountsSource,
  ProgramAccountsTransport,
  IndexerClient,
} from "@tetsuo-ai/marketplace-sdk";

/**
 * A minimal JSON-Schema object (draft 2020-12 subset) describing a tool's
 * input. Deliberately a plain structural type so it serializes byte-for-byte
 * into every framework's function-calling contract (OpenAI `parameters`,
 * LangChain `schema`, CrewAI `args_schema`) with no transform of the schema
 * body itself.
 */
export interface JsonSchema {
  /** Always `"object"` for a tool input envelope. */
  type: "object";
  /** Property name → property schema. */
  properties: Record<string, JsonSchemaProperty>;
  /** Names of required properties. */
  required?: readonly string[];
  /** Whether properties beyond `properties` are allowed (default: false). */
  additionalProperties?: boolean;
  /** Optional human description of the whole object. */
  description?: string;
}

/** One property in a {@link JsonSchema}. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  /** Minimum Unicode code-point length for strings. */
  minLength?: number;
  /** Maximum Unicode code-point length for strings. */
  maxLength?: number;
  /** For `type: "array"`. */
  items?: JsonSchemaProperty;
  /** Minimum number of array entries. */
  minItems?: number;
  /** Maximum number of array entries. */
  maxItems?: number;
  /** Enumerated allowed values. */
  enum?: readonly (string | number)[];
  /** Minimum (numeric). */
  minimum?: number;
  /** Maximum (numeric). */
  maximum?: number;
  /** Default value surfaced to the model. */
  default?: unknown;
  /** Nested object properties (for `type: "object"`). */
  properties?: Record<string, JsonSchemaProperty>;
  /** Required nested props (for `type: "object"`). */
  required?: readonly string[];
  /** Whether undeclared nested properties are accepted (default: false). */
  additionalProperties?: boolean;
  /** A supported runtime-validated string format. */
  format?: JsonSchemaFormat;
  /** Example value. */
  examples?: readonly unknown[];
}

/** Runtime-validated string formats supported by the tool schema subset. */
export type JsonSchemaFormat =
  | "solana-address"
  | "hex-32"
  | "nonzero-hex-32"
  | "hex-64"
  | "uint64"
  | "nonzero-uint64"
  | "int64"
  | "uri"
  | "http-url"
  | "kebab-token"
  | "listing-name";

/**
 * The runtime context every tool handler receives.
 *
 * Readonly discovery/inspection tools need only a {@link ProgramAccountsSource}
 * `read` transport (a `@solana/kit` RPC or any
 * {@link ProgramAccountsTransport}, e.g. the hosted indexer client). The
 * mutation-PREPARE tools additionally need either the same `read` source
 * (for account-existence reads) and produce an UNSIGNED instruction via the
 * SDK facade — they NEVER hold a key, sign, or broadcast.
 *
 * An optional {@link IndexerClient} `indexer` unlocks the richer hosted read
 * model (track-record, paged listings, server-built hire transactions) when
 * present; tools degrade to the trustless gPA path when it is absent.
 */
export interface MarketplaceToolContext {
  /**
   * The read transport: a kit `Rpc<GetProgramAccountsApi>` or any
   * {@link ProgramAccountsTransport}. Required by every readonly tool and by
   * the prepare-* tools (which read account state to build instructions).
   */
  read: ProgramAccountsSource;
  /**
   * A kit RPC used for single-account fetches (`fetchMaybeTask` etc.) and as
   * the source for facade async instruction builders that auto-derive PDAs.
   * When omitted, tools that need a single-account read fall back to `read`
   * if it is itself a kit RPC, otherwise they throw a typed error.
   */
  rpc?: KitRpcLike;
  /**
   * Optional hosted indexer client (the scale read path + no-RPC tx builder).
   * When present, `get_agent_track_record` and `search` use it; `prepare_hire`
   * can build the hire transaction server-side instead of locally.
   */
  indexer?: IndexerClient;
  /**
   * The agenc-coordination program address. Defaults to the canonical mainnet/
   * devnet/localnet program id when omitted.
   */
  programAddress?: Address;
}

/**
 * A `@solana/kit` RPC object surface used for single-account fetches and as the
 * driver for facade async instruction builders. Kept structural so callers are
 * not forced to import the full kit `Rpc` generic. Derived from the SDK
 * `facade.getAgentTrackRecord`'s first parameter (anything `fetchEncodedAccount`
 * accepts).
 */
export type KitRpcLike = Parameters<
  typeof import("@tetsuo-ai/marketplace-sdk").facade.getAgentTrackRecord
>[0];

/**
 * A framework-neutral marketplace tool. The schema is the source of truth; the
 * adapters never re-author it.
 *
 * @typeParam TArgs - the validated argument shape the handler receives.
 * @typeParam TResult - the handler's return value (JSON-serializable).
 */
export interface MarketplaceTool<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> {
  /** Stable, namespaced tool name (e.g. `"list_listings"`). */
  readonly name: string;
  /** One-paragraph description for the model. */
  readonly description: string;
  /** JSON-Schema for the tool's input object. */
  readonly inputSchema: JsonSchema;
  /**
   * Whether this tool mutates anything. Discovery/inspection tools are
   * `"readonly"`; the prepare-* tools are `"prepare"` — they BUILD an unsigned
   * instruction/transaction and return it, but still never sign or send.
   * There is intentionally no `"mutate"` kind in this public package: signing
   * and broadcasting are the consumer's responsibility, behind their own
   * policy gate.
   */
  readonly kind: "readonly" | "prepare";
  /**
   * Execute the tool. Definitions and registries compile `inputSchema` and
   * validate `args` before this implementation runs; handlers additionally
   * defend protocol-specific invariants that JSON Schema cannot express.
   */
  handler(args: TArgs, ctx: MarketplaceToolContext): Promise<TResult>;
}

/** An immutable registry: tool name → tool. */
export type MarketplaceToolRegistry = ReadonlyMap<string, MarketplaceTool>;

/**
 * Define a tool with a strongly-typed argument shape, returning it widened to
 * the registry's `MarketplaceTool` element type. This keeps each handler's
 * `args` precisely typed at the definition site while letting the tools live in
 * a homogeneous `MarketplaceTool[]` registry (TypeScript treats the handler's
 * parameter contravariantly, so a narrower `TArgs` is not assignable to the
 * default `Record<string, unknown>` without this seam).
 */
export function defineTool<TArgs, TResult>(
  tool: MarketplaceTool<TArgs, TResult>,
): MarketplaceTool {
  return ensureValidatedMarketplaceTool(tool) as unknown as MarketplaceTool;
}

/** Error thrown when a tool is misconfigured or its context is insufficient. */
export class MarketplaceToolError extends Error {
  /** Stable machine code. */
  readonly code: string;
  /** The tool that raised it (when known). */
  readonly tool?: string;
  constructor(code: string, message: string, tool?: string) {
    super(message);
    this.name = "MarketplaceToolError";
    this.code = code;
    if (tool !== undefined) this.tool = tool;
  }
}

type InputValidator = (value: unknown, path: string) => void;

const ROOT_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "description",
]);
const PROPERTY_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "minLength",
  "maxLength",
  "items",
  "minItems",
  "maxItems",
  "enum",
  "minimum",
  "maximum",
  "default",
  "properties",
  "required",
  "additionalProperties",
  "format",
  "examples",
]);
const PROPERTY_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);
const STRING_FORMATS = new Set<JsonSchemaFormat>([
  "solana-address",
  "hex-32",
  "nonzero-hex-32",
  "hex-64",
  "uint64",
  "nonzero-uint64",
  "int64",
  "uri",
  "http-url",
  "kebab-token",
  "listing-name",
]);
const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;
const CONTENT_URI_PROTOCOLS = new Set([
  "agenc:",
  "ar:",
  "http:",
  "https:",
  "ipfs:",
]);
const utf8Encoder = new TextEncoder();

const validatedTools = new WeakSet<object>();
const validatedToolCache = new WeakMap<object, MarketplaceTool>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaFailure(toolName: string, path: string, reason: string): never {
  throw new MarketplaceToolError(
    "INVALID_TOOL_SCHEMA",
    `Invalid input schema at ${path}: ${reason}`,
    toolName,
  );
}

function inputFailure(toolName: string, path: string, reason: string): never {
  throw new MarketplaceToolError(
    "INVALID_TOOL_INPUT",
    `Invalid tool input at ${path}: ${reason}`,
    toolName,
  );
}

function assertSupportedKeys(
  value: Record<string, unknown>,
  supported: ReadonlySet<string>,
  toolName: string,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) {
      schemaFailure(toolName, `${path}.${key}`, "unsupported schema keyword");
    }
  }
}

function compileRequired(
  required: unknown,
  properties: Record<string, unknown>,
  toolName: string,
  path: string,
): readonly string[] {
  if (required === undefined) return [];
  if (
    !Array.isArray(required) ||
    required.some((entry) => typeof entry !== "string")
  ) {
    schemaFailure(toolName, `${path}.required`, "must be an array of strings");
  }
  const names = required as string[];
  if (new Set(names).size !== names.length) {
    schemaFailure(toolName, `${path}.required`, "must not contain duplicates");
  }
  for (const name of names) {
    if (!Object.hasOwn(properties, name)) {
      schemaFailure(
        toolName,
        `${path}.required`,
        `required property ${JSON.stringify(name)} is not declared`,
      );
    }
  }
  return names;
}

function compileObjectValidator(
  propertiesValue: unknown,
  requiredValue: unknown,
  additionalPropertiesValue: unknown,
  toolName: string,
  path: string,
): InputValidator {
  if (!isPlainRecord(propertiesValue)) {
    schemaFailure(toolName, `${path}.properties`, "must be a plain object");
  }
  if (
    additionalPropertiesValue !== undefined &&
    typeof additionalPropertiesValue !== "boolean"
  ) {
    schemaFailure(
      toolName,
      `${path}.additionalProperties`,
      "must be a boolean",
    );
  }
  const properties = propertiesValue;
  const required = compileRequired(requiredValue, properties, toolName, path);
  const propertyValidators = new Map<string, InputValidator>();
  for (const [name, propertySchema] of Object.entries(properties)) {
    propertyValidators.set(
      name,
      compilePropertyValidator(
        propertySchema,
        toolName,
        `${path}.properties.${name}`,
      ),
    );
  }
  const allowAdditional = additionalPropertiesValue === true;

  return (value, inputPath) => {
    if (!isPlainRecord(value)) {
      inputFailure(toolName, inputPath, "expected an object");
    }
    for (const name of required) {
      if (!Object.hasOwn(value, name)) {
        inputFailure(
          toolName,
          `${inputPath}.${name}`,
          "required property is missing",
        );
      }
    }
    for (const [name, entry] of Object.entries(value)) {
      const validate = propertyValidators.get(name);
      if (validate === undefined) {
        if (!allowAdditional) {
          inputFailure(
            toolName,
            `${inputPath}.${name}`,
            "property is not allowed",
          );
        }
        continue;
      }
      validate(entry, `${inputPath}.${name}`);
    }
  };
}

function assertFiniteSchemaNumber(
  value: unknown,
  toolName: string,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    schemaFailure(toolName, path, "must be a finite number");
  }
  return value;
}

function assertNonNegativeSchemaInteger(
  value: unknown,
  toolName: string,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    schemaFailure(toolName, path, "must be a non-negative safe integer");
  }
  return value as number;
}

function decodedBase58Length(value: string): number | null {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") {
    leadingZeros += 1;
  }
  const bytes = [0];
  for (let index = leadingZeros; index < value.length; index += 1) {
    const digit = alphabet.indexOf(value[index] as string);
    if (digit < 0) return null;
    let carry = digit;
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
      carry += (bytes[byteIndex] as number) * 58;
      bytes[byteIndex] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const significantBytes =
    bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length;
  return leadingZeros + significantBytes;
}

function validateStringFormat(
  value: string,
  format: JsonSchemaFormat,
  toolName: string,
  path: string,
  maxLength?: number,
): void {
  let valid = false;
  switch (format) {
    case "solana-address":
      valid =
        value.length >= 32 &&
        value.length <= 44 &&
        decodedBase58Length(value) === 32;
      break;
    case "hex-32":
      valid = /^[0-9a-fA-F]{64}$/.test(value);
      break;
    case "nonzero-hex-32":
      valid = /^[0-9a-fA-F]{64}$/.test(value) && !/^0{64}$/.test(value);
      break;
    case "hex-64":
      valid = /^[0-9a-fA-F]{128}$/.test(value);
      break;
    case "uint64":
      valid =
        value.length <= 20 &&
        /^(0|[1-9][0-9]*)$/.test(value) &&
        BigInt(value) <= U64_MAX;
      break;
    case "nonzero-uint64":
      valid =
        value.length <= 20 &&
        /^[1-9][0-9]*$/.test(value) &&
        BigInt(value) <= U64_MAX;
      break;
    case "int64":
      if (/^(0|-?[1-9][0-9]*)$/.test(value) && value.length <= 20) {
        const parsed = BigInt(value);
        valid = parsed >= I64_MIN && parsed <= I64_MAX;
      }
      break;
    case "uri": {
      if (
        utf8Encoder.encode(value).length > Math.min(maxLength ?? 256, 256) ||
        value.trim() !== value ||
        /\s/u.test(value) ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        break;
      }
      try {
        const parsed = new URL(value);
        valid =
          CONTENT_URI_PROTOCOLS.has(parsed.protocol) &&
          parsed.hostname.length > 0 &&
          !parsed.username &&
          !parsed.password;
      } catch {
        valid = false;
      }
      break;
    }
    case "http-url": {
      if (
        utf8Encoder.encode(value).length > 128 ||
        value.trim() !== value ||
        /\s/u.test(value) ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        break;
      }
      try {
        const parsed = new URL(value);
        valid =
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.hostname.length > 0 &&
          !parsed.username &&
          !parsed.password;
      } catch {
        valid = false;
      }
      break;
    }
    case "kebab-token":
      valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
      break;
    case "listing-name":
      valid =
        value.trim().length > 0 &&
        !value.includes("\u0000") &&
        utf8Encoder.encode(value).length <= 32;
      break;
  }
  if (!valid) {
    inputFailure(toolName, path, `expected format ${format}`);
  }
}

function compilePropertyValidator(
  schemaValue: unknown,
  toolName: string,
  path: string,
): InputValidator {
  if (!isPlainRecord(schemaValue)) {
    schemaFailure(toolName, path, "must be a plain object");
  }
  assertSupportedKeys(schemaValue, PROPERTY_SCHEMA_KEYS, toolName, path);
  const type = schemaValue.type;
  if (typeof type !== "string" || !PROPERTY_TYPES.has(type)) {
    schemaFailure(toolName, `${path}.type`, "is missing or unsupported");
  }
  if (
    schemaValue.description !== undefined &&
    typeof schemaValue.description !== "string"
  ) {
    schemaFailure(toolName, `${path}.description`, "must be a string");
  }

  const minimum = assertFiniteSchemaNumber(
    schemaValue.minimum,
    toolName,
    `${path}.minimum`,
  );
  const maximum = assertFiniteSchemaNumber(
    schemaValue.maximum,
    toolName,
    `${path}.maximum`,
  );
  if (
    (minimum !== undefined || maximum !== undefined) &&
    type !== "number" &&
    type !== "integer"
  ) {
    schemaFailure(toolName, path, "minimum/maximum require a numeric type");
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    schemaFailure(toolName, path, "minimum must not exceed maximum");
  }

  const minLength = assertNonNegativeSchemaInteger(
    schemaValue.minLength,
    toolName,
    `${path}.minLength`,
  );
  const maxLength = assertNonNegativeSchemaInteger(
    schemaValue.maxLength,
    toolName,
    `${path}.maxLength`,
  );
  if (
    (minLength !== undefined || maxLength !== undefined) &&
    type !== "string"
  ) {
    schemaFailure(toolName, path, "minLength/maxLength require a string type");
  }
  if (
    minLength !== undefined &&
    maxLength !== undefined &&
    minLength > maxLength
  ) {
    schemaFailure(toolName, path, "minLength must not exceed maxLength");
  }

  const minItems = assertNonNegativeSchemaInteger(
    schemaValue.minItems,
    toolName,
    `${path}.minItems`,
  );
  const maxItems = assertNonNegativeSchemaInteger(
    schemaValue.maxItems,
    toolName,
    `${path}.maxItems`,
  );
  if ((minItems !== undefined || maxItems !== undefined) && type !== "array") {
    schemaFailure(toolName, path, "minItems/maxItems require an array type");
  }
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    schemaFailure(toolName, path, "minItems must not exceed maxItems");
  }

  let format: JsonSchemaFormat | undefined;
  if (schemaValue.format !== undefined) {
    if (
      type !== "string" ||
      typeof schemaValue.format !== "string" ||
      !STRING_FORMATS.has(schemaValue.format as JsonSchemaFormat)
    ) {
      schemaFailure(toolName, `${path}.format`, "is unsupported for this type");
    }
    format = schemaValue.format as JsonSchemaFormat;
  }

  let itemValidator: InputValidator | undefined;
  if (type === "array") {
    if (schemaValue.items === undefined) {
      schemaFailure(
        toolName,
        `${path}.items`,
        "is required for array properties",
      );
    }
    itemValidator = compilePropertyValidator(
      schemaValue.items,
      toolName,
      `${path}.items`,
    );
  } else if (schemaValue.items !== undefined) {
    schemaFailure(toolName, `${path}.items`, "is only valid for arrays");
  }

  let objectValidator: InputValidator | undefined;
  if (type === "object") {
    objectValidator = compileObjectValidator(
      schemaValue.properties ?? {},
      schemaValue.required,
      schemaValue.additionalProperties,
      toolName,
      path,
    );
  } else if (
    schemaValue.properties !== undefined ||
    schemaValue.required !== undefined ||
    schemaValue.additionalProperties !== undefined
  ) {
    schemaFailure(
      toolName,
      path,
      "properties/required/additionalProperties require an object type",
    );
  }

  let enumValues: readonly unknown[] | undefined;
  if (schemaValue.enum !== undefined) {
    if (!Array.isArray(schemaValue.enum) || schemaValue.enum.length === 0) {
      schemaFailure(toolName, `${path}.enum`, "must be a non-empty array");
    }
    enumValues = schemaValue.enum;
    const comparable = enumValues.map(
      (entry) => `${typeof entry}:${String(entry)}`,
    );
    if (new Set(comparable).size !== comparable.length) {
      schemaFailure(toolName, `${path}.enum`, "must not contain duplicates");
    }
    for (const entry of enumValues) {
      const valid =
        (type === "string" && typeof entry === "string") ||
        (type === "number" &&
          typeof entry === "number" &&
          Number.isFinite(entry)) ||
        (type === "integer" &&
          typeof entry === "number" &&
          Number.isSafeInteger(entry));
      if (!valid) {
        schemaFailure(
          toolName,
          `${path}.enum`,
          `contains a value incompatible with ${type}`,
        );
      }
    }
  }
  if (
    schemaValue.examples !== undefined &&
    !Array.isArray(schemaValue.examples)
  ) {
    schemaFailure(toolName, `${path}.examples`, "must be an array");
  }

  const validator: InputValidator = (value, inputPath) => {
    switch (type) {
      case "string":
        if (typeof value !== "string")
          inputFailure(toolName, inputPath, "expected a string");
        if (format !== undefined)
          validateStringFormat(
            value as string,
            format,
            toolName,
            inputPath,
            maxLength,
          );
        {
          const length = [...(value as string)].length;
          if (minLength !== undefined && length < minLength) {
            inputFailure(
              toolName,
              inputPath,
              `must contain at least ${minLength} characters`,
            );
          }
          if (maxLength !== undefined && length > maxLength) {
            inputFailure(
              toolName,
              inputPath,
              `must contain at most ${maxLength} characters`,
            );
          }
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          inputFailure(toolName, inputPath, "expected a finite number");
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          inputFailure(toolName, inputPath, "expected a safe integer");
        }
        break;
      case "boolean":
        if (typeof value !== "boolean")
          inputFailure(toolName, inputPath, "expected a boolean");
        break;
      case "array":
        if (!Array.isArray(value))
          inputFailure(toolName, inputPath, "expected an array");
        if (minItems !== undefined && (value as unknown[]).length < minItems) {
          inputFailure(
            toolName,
            inputPath,
            `must contain at least ${minItems} items`,
          );
        }
        if (maxItems !== undefined && (value as unknown[]).length > maxItems) {
          inputFailure(
            toolName,
            inputPath,
            `must contain at most ${maxItems} items`,
          );
        }
        (value as unknown[]).forEach((entry, index) =>
          itemValidator!(entry, `${inputPath}[${index}]`),
        );
        break;
      case "object":
        objectValidator!(value, inputPath);
        break;
    }
    if (
      enumValues !== undefined &&
      !enumValues.some((entry) => Object.is(entry, value))
    ) {
      inputFailure(toolName, inputPath, "value is not in the allowed enum");
    }
    if (typeof value === "number") {
      if (minimum !== undefined && value < minimum) {
        inputFailure(toolName, inputPath, `must be at least ${minimum}`);
      }
      if (maximum !== undefined && value > maximum) {
        inputFailure(toolName, inputPath, `must be at most ${maximum}`);
      }
    }
  };

  const validateSchemaExample = (value: unknown, examplePath: string): void => {
    try {
      validator(value, examplePath);
    } catch (error) {
      const reason =
        error instanceof MarketplaceToolError ? error.message : String(error);
      schemaFailure(
        toolName,
        examplePath,
        `does not satisfy its schema: ${reason}`,
      );
    }
  };
  if (Object.hasOwn(schemaValue, "default")) {
    validateSchemaExample(schemaValue.default, `${path}.default`);
  }
  if (Array.isArray(schemaValue.examples)) {
    schemaValue.examples.forEach((example, index) =>
      validateSchemaExample(example, `${path}.examples[${index}]`),
    );
  }
  return validator;
}

function compileToolInputValidator(tool: MarketplaceTool): InputValidator {
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    schemaFailure(tool.name || "<unnamed>", "$", "tool name must be non-empty");
  }
  if (typeof tool.description !== "string" || tool.description.length === 0) {
    schemaFailure(tool.name, "$", "tool description must be non-empty");
  }
  if (tool.kind !== "readonly" && tool.kind !== "prepare") {
    schemaFailure(tool.name, "$.kind", "must be readonly or prepare");
  }
  if (typeof tool.handler !== "function") {
    schemaFailure(tool.name, "$.handler", "must be a function");
  }
  const schema = tool.inputSchema as unknown;
  if (!isPlainRecord(schema)) {
    schemaFailure(tool.name, "$", "inputSchema must be a plain object");
  }
  assertSupportedKeys(schema, ROOT_SCHEMA_KEYS, tool.name, "$schema");
  if (schema.type !== "object") {
    schemaFailure(tool.name, "$schema.type", 'must be "object"');
  }
  if (
    schema.description !== undefined &&
    typeof schema.description !== "string"
  ) {
    schemaFailure(tool.name, "$schema.description", "must be a string");
  }
  return compileObjectValidator(
    schema.properties,
    schema.required,
    schema.additionalProperties,
    tool.name,
    "$schema",
  );
}

/**
 * Compile and attach fail-closed runtime input validation to a tool. Used by
 * definitions, registries, and bound framework adapters so the advertised
 * schema and handler boundary cannot diverge.
 *
 * @internal
 */
export function ensureValidatedMarketplaceTool<TArgs, TResult>(
  tool: MarketplaceTool<TArgs, TResult>,
): MarketplaceTool<TArgs, TResult> {
  if (tool === null || typeof tool !== "object") {
    schemaFailure("<invalid>", "$", "tool definition must be an object");
  }
  if (validatedTools.has(tool as object)) return tool;
  const cached = validatedToolCache.get(tool as object);
  if (cached !== undefined) {
    return cached as MarketplaceTool<TArgs, TResult>;
  }
  const immutableSchema = snapshotInputSchema(tool.inputSchema);
  const immutableTool = {
    ...tool,
    inputSchema: immutableSchema,
  } as MarketplaceTool<TArgs, TResult>;
  const validate = compileToolInputValidator(immutableTool as MarketplaceTool);
  const handler = tool.handler.bind(tool);
  const wrapped: MarketplaceTool<TArgs, TResult> = {
    ...immutableTool,
    async handler(args, ctx) {
      validate(args, "$input");
      return handler(args, ctx);
    },
  };
  validatedTools.add(wrapped as object);
  validatedToolCache.set(tool as object, wrapped as MarketplaceTool);
  return wrapped;
}

function cloneSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneSchemaValue(entry));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneSchemaValue(entry),
      ]),
    );
  }
  return value;
}

function applyObjectSchemaDefaults(value: unknown): void {
  if (!isPlainRecord(value)) return;
  if (value.type === "object") {
    if (!Object.hasOwn(value, "additionalProperties")) {
      value.additionalProperties = false;
    }
    if (isPlainRecord(value.properties)) {
      for (const property of Object.values(value.properties)) {
        applyObjectSchemaDefaults(property);
      }
    }
  }
  if (value.type === "array") {
    applyObjectSchemaDefaults(value.items);
  }
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry));
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    Object.values(value).forEach((entry) => deepFreeze(entry));
    return Object.freeze(value);
  }
  return value;
}

function snapshotInputSchema(schema: JsonSchema): JsonSchema {
  const clone = cloneSchemaValue(schema);
  applyObjectSchemaDefaults(clone);
  return deepFreeze(clone) as JsonSchema;
}
