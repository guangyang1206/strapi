import { errors, contentTypes, async as asyncPipe, z } from '@strapi/utils';
import type { Core, Schema, Struct, Modules, UID } from '@strapi/types';

import { ACTIONS } from '../services/permission-checker';
import { getService } from '../utils';
import { getDocumentLocaleAndStatus } from '../controllers/validation/dimensions';
import { formatDocumentWithMetadata } from '../controllers/utils/metadata';
import { indexByDocumentId } from '../controllers/utils/document-status';
import { getPopulateForLocalizations } from '../services/utils/populate';

export type ContentManagerModelForMcp = Pick<
  Struct.ContentTypeSchema,
  'uid' | 'kind' | 'options'
> & {
  /** Present on content-manager DTOs from data-mapper.toContentManagerModel */
  apiID: string;
  /**
   * Formatted attributes from data-mapper.toContentManagerModel (includes id, documentId,
   * timestamps, creator fields).
   */
  attributes: Struct.SchemaAttributes;
};

export const slugifyUidForMcpToolName = (uid: string): string => {
  const [namespace, modelName] = uid.split('::');
  const modelNameParts = modelName.split('.').map((part) => part.toLowerCase());
  return `${namespace.toLowerCase()}_${modelNameParts[0]}`;
};

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

const localeSchema = z
  .string()
  .optional()
  .describe('Locale code (e.g. "en", "fr"). Defaults to the default locale.');

type McpToolsBuildContext = {
  /** Installed locale codes from i18n plugin. null when i18n is not installed. */
  localeCodes: [string, ...string[]] | null;
};

const buildLocaleSchema = (localeCodes: [string, ...string[]] | null): z.ZodTypeAny => {
  if (localeCodes !== null && localeCodes.length > 0) {
    return z
      .enum(localeCodes)
      .optional()
      .describe(
        `Locale code. Available: ${localeCodes.join(', ')}. Defaults to the default locale.`
      );
  }

  return z
    .string()
    .optional()
    .describe('Locale code (e.g. "en", "fr"). Defaults to the default locale.');
};

const statusSchema = z
  .enum(['draft', 'published'])
  .optional()
  .describe('Document status. Defaults to "draft" when draftAndPublish is enabled.');

const documentIdSchema = z
  .string()
  .min(1)
  .describe(
    'Stable document ID (e.g. "z7v8zma53x01r6oceimv922b"). Use this as the canonical identifier across draft/published versions; numeric "id" can differ per version row.'
  );

const pageSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('Page number (1-indexed, default: 1).');

const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Items per page (default: 25, max: 100).');

// ---------------------------------------------------------------------------
// Scalar attribute types — eligible for sort field names and filter operators
// ---------------------------------------------------------------------------

const SCALAR_ATTRIBUTE_TYPES = new Set([
  'string',
  'text',
  'richtext',
  'email',
  'password',
  'uid',
  'integer',
  'biginteger',
  'decimal',
  'float',
  'boolean',
  'date',
  'datetime',
  'time',
  'timestamp',
  'enumeration',
]);

/**
 * Returns the list of scalar attribute keys from a content type's attributes.
 * Relation, component, dynamiczone, media, json, and blocks are excluded because
 * they cannot be meaningfully sorted or filtered via simple operators.
 */
const getScalarAttributeKeys = (attributes: Struct.SchemaAttributes): string[] =>
  Object.entries(attributes)
    .filter(
      ([, attr]) =>
        SCALAR_ATTRIBUTE_TYPES.has(attr.type) && (attr as { private?: boolean }).private !== true
    )
    .map(([key]) => key);

// ---------------------------------------------------------------------------
// Per-content-type sort schema builder
// ---------------------------------------------------------------------------

/**
 * Builds a per-content-type sort Zod schema constrained to the model's scalar fields.
 *
 * Supports all four Strapi sort notations:
 *   - string:        "title:asc"
 *   - string[]:      ["title:asc", "createdAt:desc"]
 *   - object:        { title: "asc" }
 *   - object[]:      [{ title: "asc" }, { createdAt: "desc" }]
 *
 * Object forms have their keys constrained to known scalar attribute names.
 * If the model has no scalar attributes, the schema is z.never() (sort not allowed).
 */
export const buildSortSchema = (attributes: Struct.SchemaAttributes): z.ZodTypeAny => {
  const scalarKeys = getScalarAttributeKeys(attributes);

  if (scalarKeys.length === 0) {
    return z.never();
  }

  const directionSchema = z.enum(['asc', 'desc']);
  const sortObjectSchema = z.object(
    Object.fromEntries(scalarKeys.map((key) => [key, directionSchema.optional()]))
  );

  return z
    .union([z.string(), z.array(z.string()), sortObjectSchema, z.array(sortObjectSchema)])
    .optional()
    .describe(
      `Sort expression. String: "field:asc". Array: ["field:asc"]. Object: { field: "asc" }. ` +
        `Valid fields: ${scalarKeys.join(', ')}.`
    );
};

// ---------------------------------------------------------------------------
// Per-content-type filters schema builder
// ---------------------------------------------------------------------------

/**
 * Maps a scalar Strapi attribute type to the appropriate Zod leaf value schema
 * used inside filter operator objects (e.g. { $eq: <value> }).
 */
const attributeTypeToFilterValue = (attr: Schema.Attribute.AnyAttribute): z.ZodTypeAny => {
  switch (attr.type) {
    case 'integer':
    case 'biginteger':
    case 'decimal':
    case 'float':
      return z.union([z.number(), z.array(z.number())]);
    case 'boolean':
      return z.boolean();
    case 'enumeration': {
      const enumAttr = attr as Schema.Attribute.Enumeration<string[]>;
      if (Array.isArray(enumAttr.enum) && enumAttr.enum.length > 0) {
        return z.union([
          z.enum(enumAttr.enum as [string, ...string[]]),
          z.array(z.enum(enumAttr.enum as [string, ...string[]])),
        ]);
      }
      return z.union([z.string(), z.array(z.string())]);
    }
    default:
      // string, text, richtext, email, password, uid, date, datetime, time, timestamp
      return z.union([z.string(), z.array(z.string()), z.null()]);
  }
};

// All Strapi filter operators (excluding experimental $jsonSupersetOf)
const FILTER_OPERATORS = [
  '$eq',
  '$eqi',
  '$ne',
  '$nei',
  '$in',
  '$notIn',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$between',
  '$contains',
  '$notContains',
  '$containsi',
  '$notContainsi',
  '$startsWith',
  '$startsWithi',
  '$endsWith',
  '$endsWithi',
  '$null',
  '$notNull',
] as const;

/**
 * Builds a per-content-type recursive filters Zod schema.
 *
 * Shape:
 *   - Logical operators: $and, $or accept an array of filter objects.
 *   - Logical operator: $not accepts a single filter object.
 *   - Field keys (scalar attrs only): accept either a direct value (implicit $eq)
 *     or an operator object { $eq, $contains, $gt, … }.
 *
 * If the model has no scalar attributes, the schema is z.never() (filters not allowed).
 */
export const buildFiltersSchema = (attributes: Struct.SchemaAttributes): z.ZodTypeAny => {
  const scalarKeys = getScalarAttributeKeys(attributes);

  if (scalarKeys.length === 0) {
    return z.never();
  }

  // Lazy reference for recursion ($and / $or / $not)
  const filtersSchema: z.ZodTypeAny = z.lazy(() => {
    const fieldShapes: Record<string, z.ZodTypeAny> = {};

    for (const key of scalarKeys) {
      const attr = attributes[key];
      const valueSchema = attributeTypeToFilterValue(attr);
      const operatorObject = z.object(
        Object.fromEntries(FILTER_OPERATORS.map((op) => [op, valueSchema.optional()]))
      );
      // Field accepts either a direct value (implicit $eq) or operator object
      fieldShapes[key] = z.union([valueSchema, operatorObject]).optional();
    }

    return z.object({
      $and: z.array(filtersSchema).optional(),
      $or: z.array(filtersSchema).optional(),
      $not: filtersSchema.optional(),
      ...fieldShapes,
    });
  });

  return filtersSchema
    .optional()
    .describe(
      `Filter object. Supports logical operators ($and, $or, $not) and field operators ` +
        `($eq, $ne, $in, $contains, $gt, $lt, etc.). Valid fields: ${scalarKeys.join(', ')}.`
    );
};

const collectionGetInputSchema = z.object({
  documentId: documentIdSchema,
  locale: localeSchema,
  status: statusSchema,
});

// Placeholder data schema for handler type inference — the actual per-content-type
// derived schema (from buildDataSchema) is injected at tool-definition build time.
const writeDataPlaceholder = z
  .record(z.string(), z.unknown())
  .describe('Document field values to write.');

const collectionCreateInputSchema = z.object({
  data: writeDataPlaceholder,
  locale: localeSchema,
});

const collectionUpdateInputSchema = z.object({
  documentId: documentIdSchema,
  data: writeDataPlaceholder,
  locale: localeSchema,
});

const collectionDeleteInputSchema = z.object({
  documentId: documentIdSchema,
  locale: localeSchema,
});

const collectionPublishInputSchema = z.object({
  documentId: documentIdSchema,
  locale: localeSchema,
});

const collectionUnpublishInputSchema = z.object({
  documentId: documentIdSchema,
  locale: localeSchema,
  discardDraft: z.boolean().optional().describe('Also discard the draft when unpublishing.'),
});

const collectionDiscardDraftInputSchema = z.object({
  documentId: documentIdSchema,
  locale: localeSchema,
});

// Single-type inputs
const singleGetInputSchema = z.object({
  locale: localeSchema,
  status: statusSchema,
});

const singleWriteInputSchema = z.object({
  data: writeDataPlaceholder,
  locale: localeSchema,
});

const singleDeleteInputSchema = z.object({
  locale: localeSchema,
});

const singlePublishInputSchema = z.object({
  locale: localeSchema,
});

const singleUnpublishInputSchema = z.object({
  locale: localeSchema,
  discardDraft: z.boolean().optional().describe('Also discard the draft when unpublishing.'),
});

const singleDiscardDraftInputSchema = z.object({
  locale: localeSchema,
});

// ---------------------------------------------------------------------------
// Per-content-type data schema derivation
// ---------------------------------------------------------------------------

/**
 * Maps a single Strapi attribute to a Zod input schema, carrying constraints
 * (min, max, minLength, maxLength, required, enum values, etc.).
 *
 * Mirrors the `mapAttributeToInputSchema` logic from
 * `packages/core/core/src/core-api/routes/validation/mappers.ts` — kept inline
 * here to avoid a cross-package import from @strapi/content-manager into
 * @strapi/core (which is not a listed dependency).
 *
 * TODO @Nico — custom fields call `strapi.get('custom-fields')` at schema-build
 * time; confirm with an integration test that the registry is populated when MCP
 * tools are registered (post-bootstrap).
 */
const attributeToInputSchema = (
  strapi: Core.Strapi,
  attr: Schema.Attribute.AnyAttribute
): z.ZodTypeAny => {
  switch (attr.type) {
    case 'string':
    case 'text':
    case 'richtext':
    case 'password': {
      const { required, minLength, maxLength } = attr as Schema.Attribute.String;
      let s: z.ZodString = z.string();
      if (minLength !== undefined) s = s.min(minLength);
      if (maxLength !== undefined) s = s.max(maxLength);
      return required === true ? s : s.optional();
    }
    case 'email': {
      const { required } = attr as Schema.Attribute.Email;
      const s = z.string().email();
      return required === true ? s : s.optional();
    }
    case 'uid': {
      const { required } = attr as Schema.Attribute.UID;
      const s = z.string();
      return required === true ? s : s.optional();
    }
    case 'integer': {
      const { required, min, max } = attr as Schema.Attribute.Integer;
      let s = z.number().int();
      if (min !== undefined) s = s.min(min);
      if (max !== undefined) s = s.max(max);
      return required === true ? s : s.optional();
    }
    case 'biginteger': {
      const { required } = attr as Schema.Attribute.BigInteger;
      const s = z.string();
      return required === true ? s : s.optional();
    }
    case 'decimal':
    case 'float': {
      const { required, min, max } = attr as Schema.Attribute.Decimal;
      let s = z.number();
      if (min !== undefined) s = s.min(min);
      if (max !== undefined) s = s.max(max);
      return required === true ? s : s.optional();
    }
    case 'boolean': {
      const { required } = attr as Schema.Attribute.Boolean;
      const s = z.boolean();
      return required === true ? s : s.optional();
    }
    case 'date':
    case 'datetime':
    case 'time':
    case 'timestamp': {
      const { required } = attr as Schema.Attribute.Date;
      const s = z.string();
      return required === true ? s : s.optional();
    }
    case 'enumeration': {
      const { required, enum: values } = attr as Schema.Attribute.Enumeration<string[]>;
      if (Array.isArray(values) && values.length > 0) {
        const s = z.enum(values as [string, ...string[]]);
        return required === true ? s : s.optional();
      }
      const s = z.string();
      return required === true ? s : s.optional();
    }
    case 'json':
    case 'blocks': {
      const { required } = attr as Schema.Attribute.JSON;
      const s = z.any();
      return required === true ? s : s.optional();
    }
    case 'component': {
      // Cast to a plain record to avoid generic defaults on `repeatable` (Constants.False)
      const componentAttr = attr as unknown as {
        required?: boolean;
        repeatable?: boolean;
        min?: number;
        max?: number;
      };
      let s: z.ZodTypeAny = componentAttr.repeatable === true ? z.array(z.any()) : z.any();
      if (componentAttr.repeatable === true && componentAttr.min !== undefined) {
        s = (s as z.ZodArray<z.ZodAny>).min(componentAttr.min);
      }
      if (componentAttr.repeatable === true && componentAttr.max !== undefined) {
        s = (s as z.ZodArray<z.ZodAny>).max(componentAttr.max);
      }
      return componentAttr.required === true ? s : s.optional();
    }
    case 'dynamiczone': {
      const dzAttr = attr as unknown as { required?: boolean; min?: number; max?: number };
      let s: z.ZodTypeAny = z.array(z.any());
      if (dzAttr.min !== undefined) s = (s as z.ZodArray<z.ZodAny>).min(dzAttr.min);
      if (dzAttr.max !== undefined) s = (s as z.ZodArray<z.ZodAny>).max(dzAttr.max);
      return dzAttr.required === true ? s : s.optional();
    }
    case 'media': {
      // TODO @Nico — if upload plugin is absent this still works (z.any / z.array(z.any()))
      const mediaAttr = attr as unknown as { required?: boolean; multiple?: boolean };
      const s: z.ZodTypeAny = mediaAttr.multiple === true ? z.array(z.any()) : z.any();
      return mediaAttr.required === true ? s : s.optional();
    }
    case 'relation': {
      // TODO @Nico — only the documentId connect shape is modelled here;
      // the { connect: [...] } relation syntax is a future enhancement.
      const { required } = attr as Schema.Attribute.Relation;
      const isToMany = (attr as Schema.Attribute.Relation).relation?.endsWith('ToMany') === true;
      // Strapi document IDs are nanoid-style strings (e.g. "z7v8zma53x01r6oceimv922b"), never UUID format.
      const relDocumentId = z
        .string()
        .min(1)
        .describe('Strapi document ID (e.g. "z7v8zma53x01r6oceimv922b").');
      const s: z.ZodTypeAny = isToMany === true ? z.array(relDocumentId) : relDocumentId;
      return required === true ? s : s.optional();
    }
    default: {
      if (
        typeof attr === 'object' &&
        attr !== null &&
        (attr as unknown as Record<string, unknown>).type === 'customField' &&
        typeof (attr as unknown as Record<string, unknown>).customField === 'string'
      ) {
        const customFieldKey = (attr as unknown as Record<string, unknown>).customField as string;
        const customField = strapi.get('custom-fields').get(customFieldKey);
        if (customField !== undefined) {
          return attributeToInputSchema(strapi, {
            ...(attr as unknown as Record<string, unknown>),
            type: customField.type,
          } as unknown as Schema.Attribute.AnyAttribute);
        }
      }
      return z.unknown();
    }
  }
};

/**
 * Derives a per-content-type `data` Zod schema from the model's writable attributes.
 * Uses `contentTypes.isWritableAttribute` to filter system-managed keys
 * (id, documentId, timestamps, createdBy, updatedBy, localizations, locale, etc.).
 * Unknown keys are rejected (strict mode) — invalid field names fail at the MCP boundary.
 */
export const buildDataSchema = (
  strapi: Core.Strapi,
  schema: Struct.ContentTypeSchema | ContentManagerModelForMcp,
  attributes: Struct.SchemaAttributes
): z.ZodTypeAny => {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, attr] of Object.entries(attributes)) {
    if (
      contentTypes.isWritableAttribute(schema as Struct.ContentTypeSchema, key) === true &&
      contentTypes.isPrivateAttribute(schema as Struct.ContentTypeSchema, key) !== true
    ) {
      shape[key] = attributeToInputSchema(strapi, attr);
    }
  }

  return z.object(shape).strict().describe('Document field values to write.');
};

// ---------------------------------------------------------------------------
// Shared output schemas
// ---------------------------------------------------------------------------

const listOutputSchema = z.object({
  results: z.array(z.record(z.string(), z.unknown())),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    pageCount: z.number(),
    total: z.number(),
  }),
});

const documentOutputSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullable(),
  meta: z
    .object({
      availableLocales: z.array(z.record(z.string(), z.unknown())).optional(),
      availableStatus: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .optional(),
});

const deleteOutputSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullable(),
});

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ExplorerAuth = { action: string; subject: string };

type McpResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

type DerivedTool = {
  name: string;
  title: string;
  description: string;
  auth: ExplorerAuth;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema: z.ZodObject<z.ZodRawShape>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (
    strapi: Core.Strapi,
    context: Modules.MCP.McpHandlerContext
  ) => (args: any) => Promise<McpResult>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const authFor = (uid: string, action: string): ExplorerAuth => ({ action, subject: uid });

const ok = (structuredContent: Record<string, unknown>): McpResult => ({
  content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  structuredContent,
});

const describeTool = (params: {
  apiID: string;
  uid: string;
  operation: string;
}): { title: string; description: string } => {
  const { apiID, uid, operation } = params;
  const operationNoteByType: Partial<Record<string, string>> = {
    publish:
      ' Operates on an existing document by documentId and may return a different numeric id for the published version row.',
    unpublish:
      ' Operates on an existing document by documentId and may return a different numeric id for the draft version row.',
    discard_draft:
      ' Operates on an existing document by documentId; treat documentId as the stable identity.',
  };

  return {
    title: `Content: ${apiID} — ${operation}`,
    description: `Content-manager ${operation} for ${uid}.${operationNoteByType[operation] ?? ''}`,
  };
};

// ---------------------------------------------------------------------------
// Collection-type handler factories
// ---------------------------------------------------------------------------

type CollectionListArgs = {
  locale?: string;
  status?: 'draft' | 'published';
  page?: number;
  pageSize?: number;
  sort?: unknown;
  filters?: unknown;
};

const createCollectionListHandler =
  (uid: UID.CollectionType) =>
  (strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: CollectionListArgs): Promise<McpResult> => {
    const { userAbility } = context;
    const { locale, status, page, pageSize, sort, filters } = args;

    const documentMetadata = getService('document-metadata');
    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({ userAbility, model: uid });

    if (permissionChecker.cannot.read()) {
      throw new errors.ForbiddenError();
    }

    const query: Record<string, unknown> = {
      ...(page !== undefined && { page }),
      ...(pageSize !== undefined && { pageSize }),
      ...(sort !== undefined && { sort }),
      ...(filters !== undefined && { filters }),
    };

    const permissionQuery = await permissionChecker.sanitizedQuery.read(query);

    const populate = await getService('populate-builder')(uid)
      .populateFromQuery(permissionQuery)
      .populateDeep(1)
      .countRelations({ toOne: false, toMany: true })
      .withPopulateOverride(getPopulateForLocalizations(uid))
      .build();

    const { locale: resolvedLocale, status: resolvedStatus } = await getDocumentLocaleAndStatus(
      { locale, status },
      uid
    );

    const { results: documents, pagination } = await documentManager.findPage(
      { ...permissionQuery, populate, locale: resolvedLocale, status: resolvedStatus } as any,
      uid
    );

    const hasDraftAndPublish = contentTypes.hasDraftAndPublish(strapi.getModel(uid));
    const statusByDocumentId = hasDraftAndPublish
      ? indexByDocumentId(await documentMetadata.getManyAvailableStatus(uid, documents))
      : new Map();

    const setStatus = (document: any) => {
      const availableStatuses = statusByDocumentId.get(document.documentId) || [];
      document.status = documentMetadata.getStatus(document, availableStatuses);
      return document;
    };

    const results = await asyncPipe.map(
      documents,
      asyncPipe.pipe(permissionChecker.sanitizeOutput, setStatus)
    );

    return ok({ results, pagination } as Record<string, unknown>);
  };

const createCollectionGetHandler =
  (uid: UID.CollectionType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof collectionGetInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { documentId, locale, status } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({ userAbility, model: uid });

    if (permissionChecker.cannot.read()) {
      throw new errors.ForbiddenError();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.read({ locale, status });

    const populate = await getService('populate-builder')(uid)
      .populateFromQuery(permissionQuery)
      .populateDeep(Infinity)
      .countRelations()
      .withPopulateOverride(getPopulateForLocalizations(uid))
      .build();

    const { locale: resolvedLocale, status: resolvedStatus } = await getDocumentLocaleAndStatus(
      { locale, status },
      uid
    );

    const version = await documentManager.findOne(documentId, uid, {
      populate,
      locale: resolvedLocale,
      status: resolvedStatus,
    });

    if (!version) {
      const exists = await documentManager.exists(uid, documentId);
      if (!exists) {
        throw new errors.NotFoundError();
      }

      const { meta } = await formatDocumentWithMetadata(
        permissionChecker,
        uid,
        { documentId, locale: resolvedLocale, publishedAt: null } as any,
        { availableLocales: true, availableStatus: false }
      );

      return ok({ data: {}, meta } as Record<string, unknown>);
    }

    if (permissionChecker.cannot.read(version)) {
      throw new errors.ForbiddenError();
    }

    const sanitizedDocument = await permissionChecker.sanitizeOutput(version);
    const result = await formatDocumentWithMetadata(permissionChecker, uid, sanitizedDocument);

    return ok(result as Record<string, unknown>);
  };

const createCollectionCreateHandler =
  (uid: UID.CollectionType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof collectionCreateInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { data, locale } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({ userAbility, model: uid });

    if (permissionChecker.cannot.create()) {
      throw new errors.ForbiddenError();
    }

    const sanitizedData = await permissionChecker.sanitizeCreateInput(data);

    // TODO @Nico [setCreatorFields] Admin API token auth doesn't resolve an admin user;
    // createdBy/updatedBy fields are not set for documents created via MCP tools.

    const { locale: resolvedLocale, status } = await getDocumentLocaleAndStatus({ locale }, uid);

    const document = await documentManager.create(uid, {
      data: sanitizedData as any,
      locale: resolvedLocale,
      status,
    });

    const sanitizedDocument = await permissionChecker.sanitizeOutput(document);
    const result = await formatDocumentWithMetadata(permissionChecker, uid, sanitizedDocument, {
      availableLocales: false,
      availableStatus: false,
    });

    return ok(result as Record<string, unknown>);
  };

const createCollectionUpdateHandler =
  (uid: UID.CollectionType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof collectionUpdateInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { documentId, data, locale } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({ userAbility, model: uid });

    if (permissionChecker.cannot.update()) {
      throw new errors.ForbiddenError();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.update({ locale });
    const populate = await getService('populate-builder')(uid)
      .populateFromQuery(permissionQuery)
      .build();

    const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

    const [documentVersion, documentExists] = await Promise.all([
      documentManager.findOne(documentId, uid, {
        populate,
        locale: resolvedLocale,
        status: 'draft',
      }),
      documentManager.exists(uid, documentId),
    ]);

    if (!documentExists) {
      throw new errors.NotFoundError();
    }

    // If version is not found but document exists, the intent is to create a new locale
    if (documentVersion) {
      if (permissionChecker.cannot.update(documentVersion)) {
        throw new errors.ForbiddenError();
      }
    } else if (permissionChecker.cannot.create()) {
      throw new errors.ForbiddenError();
    }

    const sanitizeInput = documentVersion
      ? permissionChecker.sanitizeUpdateInput(documentVersion)
      : permissionChecker.sanitizeCreateInput;

    // TODO @Nico [setCreatorFields] Admin API token auth doesn't resolve an admin user;
    // createdBy/updatedBy fields are not set for documents updated via MCP tools.
    const sanitizedData = await sanitizeInput(data);

    const updatedDocument = await documentManager.update(
      documentVersion?.documentId ?? documentId,
      uid,
      { data: sanitizedData as any, locale: resolvedLocale }
    );

    const sanitizedDocument = await permissionChecker.sanitizeOutput(updatedDocument);
    const result = await formatDocumentWithMetadata(permissionChecker, uid, sanitizedDocument);

    return ok(result as Record<string, unknown>);
  };

const createCollectionDeleteHandler =
  (uid: UID.CollectionType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof collectionDeleteInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { documentId, locale } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({ userAbility, model: uid });

    if (permissionChecker.cannot.delete()) {
      throw new errors.ForbiddenError();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.delete({ locale });
    const populate = await getService('populate-builder')(uid)
      .populateFromQuery(permissionQuery)
      .build();

    const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

    const documentLocales = await documentManager.findLocales(documentId, uid, {
      populate,
      locale: resolvedLocale,
    });

    if (documentLocales.length === 0) {
      throw new errors.NotFoundError();
    }

    for (const document of documentLocales) {
      if (permissionChecker.cannot.delete(document)) {
        throw new errors.ForbiddenError();
      }
    }

    const result = await documentManager.delete(documentId, uid, { locale: resolvedLocale });
    const sanitizedResult = await permissionChecker.sanitizeOutput(result);

    return ok({ data: sanitizedResult } as Record<string, unknown>);
  };

const createCollectionPublishHandler =
  (uid: UID.CollectionType) =>
  (strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof collectionPublishInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { documentId, locale } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({ userAbility, model: uid });

    if (permissionChecker.cannot.publish()) {
      throw new errors.ForbiddenError();
    }

    const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

    const publishedDocument = await strapi.db.transaction(async () => {
      const exists = await documentManager.exists(uid, documentId);
      if (!exists) {
        throw new errors.NotFoundError('Document not found.');
      }

      const document = await documentManager.findOne(documentId, uid, {
        locale: resolvedLocale,
        status: 'draft',
      });

      if (!document) {
        throw new errors.NotFoundError('Document locale not found.');
      }

      if (permissionChecker.cannot.publish(document)) {
        throw new errors.ForbiddenError();
      }

      const publishResult = await documentManager.publish(document.documentId, uid, {
        locale: resolvedLocale,
      });

      if (!publishResult || publishResult.length === 0) {
        throw new errors.NotFoundError('Document not found or already published.');
      }

      return publishResult[0];
    });

    const sanitizedDocument = await permissionChecker.sanitizeOutput(publishedDocument);
    const result = await formatDocumentWithMetadata(permissionChecker, uid, sanitizedDocument);

    return ok(result as Record<string, unknown>);
  };

const createCollectionUnpublishHandler =
  (uid: UID.CollectionType) =>
  (strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof collectionUnpublishInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { documentId, locale, discardDraft } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({ userAbility, model: uid });

    if (permissionChecker.cannot.unpublish()) {
      throw new errors.ForbiddenError();
    }

    if (discardDraft === true && permissionChecker.cannot.discard()) {
      throw new errors.ForbiddenError();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.unpublish({ locale });
    const populate = await getService('populate-builder')(uid)
      .populateFromQuery(permissionQuery)
      .build();

    const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

    const document = await documentManager.findOne(documentId, uid, {
      populate,
      locale: resolvedLocale,
      status: 'published',
    });

    if (!document) {
      throw new errors.NotFoundError();
    }

    if (permissionChecker.cannot.unpublish(document)) {
      throw new errors.ForbiddenError();
    }

    if (discardDraft === true && permissionChecker.cannot.discard(document)) {
      throw new errors.ForbiddenError();
    }

    const unpublishedDocument = await strapi.db.transaction(async () => {
      if (discardDraft === true) {
        await documentManager.discardDraft(document.documentId, uid, { locale: resolvedLocale });
      }

      return documentManager.unpublish(document.documentId, uid, { locale: resolvedLocale });
    });

    const sanitizedDocument = await permissionChecker.sanitizeOutput(unpublishedDocument);
    const result = await formatDocumentWithMetadata(permissionChecker, uid, sanitizedDocument);

    return ok(result as Record<string, unknown>);
  };

const createCollectionDiscardDraftHandler =
  (uid: UID.CollectionType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof collectionDiscardDraftInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { documentId, locale } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({ userAbility, model: uid });

    if (permissionChecker.cannot.discard()) {
      throw new errors.ForbiddenError();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.discard({ locale });
    const populate = await getService('populate-builder')(uid)
      .populateFromQuery(permissionQuery)
      .build();

    const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

    const document = await documentManager.findOne(documentId, uid, {
      populate,
      locale: resolvedLocale,
      status: 'published',
    });

    if (!document) {
      throw new errors.NotFoundError();
    }

    if (permissionChecker.cannot.discard(document)) {
      throw new errors.ForbiddenError();
    }

    const discardedDocument = await asyncPipe.pipe(
      (doc: any) => documentManager.discardDraft(doc.documentId, uid, { locale: resolvedLocale }),
      permissionChecker.sanitizeOutput,
      (doc: any) => formatDocumentWithMetadata(permissionChecker, uid, doc)
    )(document);

    return ok(discardedDocument as Record<string, unknown>);
  };

// ---------------------------------------------------------------------------
// Single-type handler factories
// ---------------------------------------------------------------------------

/** Shared create-or-update logic mirroring single-types controller. */
const singleCreateOrUpdate = async (
  uid: UID.SingleType,
  context: Modules.MCP.McpHandlerContext,
  args: { data: Record<string, unknown>; locale?: string }
): Promise<McpResult> => {
  const { userAbility } = context;
  const { data, locale } = args;

  const documentManager = getService('document-manager');
  const permissionChecker = getService('permission-checker').create({
    userAbility,
    model: uid as string,
  });

  if (permissionChecker.cannot.create() && permissionChecker.cannot.update()) {
    throw new errors.ForbiddenError();
  }

  const sanitizedQuery = await permissionChecker.sanitizedQuery.update({ locale });
  const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

  const populate = await getService('populate-builder')(uid as any)
    .populateFromQuery(sanitizedQuery)
    .populateDeep(Infinity)
    .countRelations()
    .withPopulateOverride(getPopulateForLocalizations(uid as any))
    .build();

  const [documentVersion, otherDocumentVersion] = await Promise.all([
    documentManager
      .findMany(
        { ...sanitizedQuery, populate, locale: resolvedLocale, status: 'draft' } as any,
        uid as any
      )
      .then((docs: any[]) => docs[0]),
    strapi.db.query(uid as any).findOne({ select: ['documentId'] }),
  ]);

  const documentId = otherDocumentVersion?.documentId;

  if (documentVersion) {
    if (permissionChecker.cannot.update(documentVersion)) {
      throw new errors.ForbiddenError();
    }
  } else if (permissionChecker.cannot.create()) {
    throw new errors.ForbiddenError();
  }

  const sanitizeInput = documentVersion
    ? permissionChecker.sanitizeUpdateInput(documentVersion)
    : permissionChecker.sanitizeCreateInput;

  // TODO @Nico [setCreatorFields] Admin API token auth doesn't resolve an admin user;
  // createdBy/updatedBy fields are not set for documents created/updated via MCP tools.
  const sanitizedData = await sanitizeInput(data);

  let result: any;

  if (!documentId) {
    result = await documentManager.create(uid as any, {
      data: sanitizedData,
      ...sanitizedQuery,
      locale: resolvedLocale,
    });
  } else {
    result = await documentManager.update(documentId, uid as any, {
      data: sanitizedData as any,
      populate,
      locale: resolvedLocale,
    });
  }

  const sanitizedDocument = await permissionChecker.sanitizeOutput(result);
  const formatted = await formatDocumentWithMetadata(
    permissionChecker,
    uid as any,
    sanitizedDocument
  );

  return ok(formatted as Record<string, unknown>);
};

const createSingleGetHandler =
  (uid: UID.SingleType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof singleGetInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { locale, status } = args;

    const permissionChecker = getService('permission-checker').create({
      userAbility,
      model: uid as string,
    });

    if (permissionChecker.cannot.read()) {
      throw new errors.ForbiddenError();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.read({ locale, status });
    const { locale: resolvedLocale, status: resolvedStatus } = await getDocumentLocaleAndStatus(
      { locale, status },
      uid
    );

    const populate = await getService('populate-builder')(uid as any)
      .populateFromQuery(permissionQuery)
      .populateDeep(Infinity)
      .countRelations()
      .withPopulateOverride(getPopulateForLocalizations(uid as any))
      .build();

    const version = await getService('document-manager')
      .findMany(
        { ...permissionQuery, populate, locale: resolvedLocale, status: resolvedStatus } as any,
        uid as any
      )
      .then((docs: any[]) => docs[0]);

    if (!version) {
      if (permissionChecker.cannot.create()) {
        throw new errors.ForbiddenError();
      }

      const document = await strapi.db.query(uid as any).findOne({});

      if (!document) {
        throw new errors.NotFoundError();
      }

      const { meta } = await formatDocumentWithMetadata(
        permissionChecker,
        uid as any,
        { documentId: document.documentId, locale: resolvedLocale, publishedAt: null } as any,
        { availableLocales: true, availableStatus: false }
      );

      return ok({ data: {}, meta } as Record<string, unknown>);
    }

    if (permissionChecker.cannot.read(version)) {
      throw new errors.ForbiddenError();
    }

    const sanitizedDocument = await permissionChecker.sanitizeOutput(version);
    const result = await formatDocumentWithMetadata(
      permissionChecker,
      uid as any,
      sanitizedDocument
    );

    return ok(result as Record<string, unknown>);
  };

const createSingleWriteHandler =
  (uid: UID.SingleType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof singleWriteInputSchema>): Promise<McpResult> => {
    return singleCreateOrUpdate(uid, context, args);
  };

const createSingleDeleteHandler =
  (uid: UID.SingleType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof singleDeleteInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { locale } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({
      userAbility,
      model: uid as string,
    });

    if (permissionChecker.cannot.delete()) {
      throw new errors.ForbiddenError();
    }

    const sanitizedQuery = await permissionChecker.sanitizedQuery.delete({ locale });

    const populate = await getService('populate-builder')(uid as any)
      .populateFromQuery(sanitizedQuery)
      .populateDeep(Infinity)
      .countRelations()
      .withPopulateOverride(getPopulateForLocalizations(uid as any))
      .build();

    const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

    const documentLocales = await documentManager.findLocales(undefined, uid as any, {
      populate,
      locale: resolvedLocale,
    });

    if (documentLocales.length === 0) {
      throw new errors.NotFoundError();
    }

    for (const document of documentLocales) {
      if (permissionChecker.cannot.delete(document)) {
        throw new errors.ForbiddenError();
      }
    }

    const deletedEntity = await documentManager.delete(documentLocales[0].documentId, uid as any, {
      locale: resolvedLocale,
    });

    const sanitizedResult = await permissionChecker.sanitizeOutput(deletedEntity);

    return ok({ data: sanitizedResult } as Record<string, unknown>);
  };

const createSinglePublishHandler =
  (uid: UID.SingleType) =>
  (strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof singlePublishInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { locale } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({
      userAbility,
      model: uid as string,
    });

    if (permissionChecker.cannot.publish()) {
      throw new errors.ForbiddenError();
    }

    const publishedDocument = await strapi.db.transaction(async () => {
      const sanitizedQuery = await permissionChecker.sanitizedQuery.publish({ locale });
      const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

      const document = await getService('document-manager')
        .findMany({ ...sanitizedQuery, locale: resolvedLocale, status: 'draft' } as any, uid as any)
        .then((docs: any[]) => docs[0]);

      if (!document) {
        throw new errors.NotFoundError('Single type document not found.');
      }

      if (permissionChecker.cannot.publish(document)) {
        throw new errors.ForbiddenError();
      }

      const publishResult = await documentManager.publish(document.documentId, uid as any, {
        locale: resolvedLocale,
      });

      return publishResult?.at(0);
    });

    const sanitizedDocument = await permissionChecker.sanitizeOutput(publishedDocument);
    const result = await formatDocumentWithMetadata(
      permissionChecker,
      uid as any,
      sanitizedDocument
    );

    return ok(result as Record<string, unknown>);
  };

const createSingleUnpublishHandler =
  (uid: UID.SingleType) =>
  (strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof singleUnpublishInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { locale, discardDraft } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({
      userAbility,
      model: uid as string,
    });

    if (permissionChecker.cannot.unpublish()) {
      throw new errors.ForbiddenError();
    }

    if (discardDraft === true && permissionChecker.cannot.discard()) {
      throw new errors.ForbiddenError();
    }

    const sanitizedQuery = await permissionChecker.sanitizedQuery.unpublish({ locale });
    const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

    const document = await getService('document-manager')
      .findMany({ ...sanitizedQuery, locale: resolvedLocale } as any, uid as any)
      .then((docs: any[]) => docs[0]);

    if (!document) {
      throw new errors.NotFoundError();
    }

    if (permissionChecker.cannot.unpublish(document)) {
      throw new errors.ForbiddenError();
    }

    if (discardDraft === true && permissionChecker.cannot.discard(document)) {
      throw new errors.ForbiddenError();
    }

    await strapi.db.transaction(async () => {
      if (discardDraft === true) {
        await documentManager.discardDraft(document.documentId, uid as any, {
          locale: resolvedLocale,
        });
      }

      await asyncPipe.pipe(
        (doc: any) =>
          documentManager.unpublish(doc.documentId, uid as any, { locale: resolvedLocale }),
        permissionChecker.sanitizeOutput,
        (doc: any) => formatDocumentWithMetadata(permissionChecker, uid as any, doc)
      )(document);
    });

    // Re-fetch after transaction to return fresh state
    const updatedDocument = await getService('document-manager')
      .findMany({ locale: resolvedLocale } as any, uid as any)
      .then((docs: any[]) => docs[0]);

    const sanitizedDocument = await permissionChecker.sanitizeOutput(updatedDocument);
    const result = await formatDocumentWithMetadata(
      permissionChecker,
      uid as any,
      sanitizedDocument
    );

    return ok(result as Record<string, unknown>);
  };

const createSingleDiscardDraftHandler =
  (uid: UID.SingleType) =>
  (_strapi: Core.Strapi, context: Modules.MCP.McpHandlerContext) =>
  async (args: z.infer<typeof singleDiscardDraftInputSchema>): Promise<McpResult> => {
    const { userAbility } = context;
    const { locale } = args;

    const documentManager = getService('document-manager');
    const permissionChecker = getService('permission-checker').create({
      userAbility,
      model: uid as string,
    });

    if (permissionChecker.cannot.discard()) {
      throw new errors.ForbiddenError();
    }

    const sanitizedQuery = await permissionChecker.sanitizedQuery.discard({ locale });
    const { locale: resolvedLocale } = await getDocumentLocaleAndStatus({ locale }, uid);

    const document = await getService('document-manager')
      .findMany(
        { ...sanitizedQuery, locale: resolvedLocale, status: 'published' } as any,
        uid as any
      )
      .then((docs: any[]) => docs[0]);

    if (!document) {
      throw new errors.NotFoundError();
    }

    if (permissionChecker.cannot.discard(document)) {
      throw new errors.ForbiddenError();
    }

    const discardedDocument = await asyncPipe.pipe(
      (doc: any) =>
        documentManager.discardDraft(doc.documentId, uid as any, { locale: resolvedLocale }),
      permissionChecker.sanitizeOutput,
      (doc: any) => formatDocumentWithMetadata(permissionChecker, uid as any, doc)
    )(document);

    return ok(discardedDocument as Record<string, unknown>);
  };

// ---------------------------------------------------------------------------
// Tool-definition builders
// ---------------------------------------------------------------------------

const buildCollectionTools = (
  strapi: Core.Strapi,
  model: ContentManagerModelForMcp,
  ctx: McpToolsBuildContext
): DerivedTool[] => {
  const uid = model.uid as UID.CollectionType;
  const slug = slugifyUidForMcpToolName(uid);
  const draftAndPublish = model.options?.draftAndPublish === true;
  const dataSchema = buildDataSchema(strapi, model, model.attributes);
  const runtimeLocaleSchema = buildLocaleSchema(ctx.localeCodes);

  const createInputSchema = z.object({ data: dataSchema, locale: runtimeLocaleSchema });
  const updateInputSchema = z.object({
    documentId: documentIdSchema,
    data: dataSchema,
    locale: runtimeLocaleSchema,
  });

  const listInputSchema = z.object({
    locale: runtimeLocaleSchema,
    status: statusSchema,
    page: pageSchema,
    pageSize: pageSizeSchema,
    sort: buildSortSchema(model.attributes),
    filters: buildFiltersSchema(model.attributes),
  });
  const getInputSchema = z.object({
    documentId: documentIdSchema,
    locale: runtimeLocaleSchema,
    status: statusSchema,
  });
  const deleteInputSchema = z.object({
    documentId: documentIdSchema,
    locale: runtimeLocaleSchema,
  });
  const publishInputSchema = z.object({
    documentId: documentIdSchema,
    locale: runtimeLocaleSchema,
  });
  const unpublishInputSchema = z.object({
    documentId: documentIdSchema,
    locale: runtimeLocaleSchema,
    discardDraft: z.boolean().optional().describe('Also discard the draft when unpublishing.'),
  });
  const discardDraftInputSchema = z.object({
    documentId: documentIdSchema,
    locale: runtimeLocaleSchema,
  });

  const tools: DerivedTool[] = [
    {
      name: `cm_${slug}_list`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'list' }),
      auth: authFor(uid, ACTIONS.read),
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      createHandler: createCollectionListHandler(uid),
    },
    {
      name: `cm_${slug}_get`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'get' }),
      auth: authFor(uid, ACTIONS.read),
      inputSchema: getInputSchema,
      outputSchema: documentOutputSchema,
      createHandler: createCollectionGetHandler(uid),
    },
    {
      name: `cm_${slug}_create`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'create' }),
      auth: authFor(uid, ACTIONS.create),
      inputSchema: createInputSchema,
      outputSchema: documentOutputSchema,
      createHandler: createCollectionCreateHandler(uid),
    },
    {
      name: `cm_${slug}_update`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'update' }),
      auth: authFor(uid, ACTIONS.update),
      inputSchema: updateInputSchema,
      outputSchema: documentOutputSchema,
      createHandler: createCollectionUpdateHandler(uid),
    },
    {
      name: `cm_${slug}_delete`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'delete' }),
      auth: authFor(uid, ACTIONS.delete),
      inputSchema: deleteInputSchema,
      outputSchema: deleteOutputSchema,
      createHandler: createCollectionDeleteHandler(uid),
    },
  ];

  if (draftAndPublish === true) {
    tools.push(
      {
        name: `cm_${slug}_publish`,
        ...describeTool({ apiID: model.apiID, uid, operation: 'publish' }),
        auth: authFor(uid, ACTIONS.publish),
        inputSchema: publishInputSchema,
        outputSchema: documentOutputSchema,
        createHandler: createCollectionPublishHandler(uid),
      },
      {
        name: `cm_${slug}_unpublish`,
        ...describeTool({ apiID: model.apiID, uid, operation: 'unpublish' }),
        auth: authFor(uid, ACTIONS.unpublish),
        inputSchema: unpublishInputSchema,
        outputSchema: documentOutputSchema,
        createHandler: createCollectionUnpublishHandler(uid),
      },
      {
        name: `cm_${slug}_discard_draft`,
        ...describeTool({ apiID: model.apiID, uid, operation: 'discard_draft' }),
        auth: authFor(uid, ACTIONS.discard),
        inputSchema: discardDraftInputSchema,
        outputSchema: documentOutputSchema,
        createHandler: createCollectionDiscardDraftHandler(uid),
      }
    );
  }

  return tools;
};

const buildSingleTypeTools = (
  strapi: Core.Strapi,
  model: ContentManagerModelForMcp,
  ctx: McpToolsBuildContext
): DerivedTool[] => {
  const uid = model.uid as UID.SingleType;
  const slug = slugifyUidForMcpToolName(uid);
  const draftAndPublish = model.options?.draftAndPublish === true;
  const dataSchema = buildDataSchema(strapi, model, model.attributes);
  const runtimeLocaleSchema = buildLocaleSchema(ctx.localeCodes);

  const writeInputSchema = z.object({ data: dataSchema, locale: runtimeLocaleSchema });
  const getInputSchema = z.object({
    locale: runtimeLocaleSchema,
    status: statusSchema,
  });
  const deleteInputSchema = z.object({
    locale: runtimeLocaleSchema,
  });
  const publishInputSchema = z.object({
    locale: runtimeLocaleSchema,
  });
  const unpublishInputSchema = z.object({
    locale: runtimeLocaleSchema,
    discardDraft: z.boolean().optional().describe('Also discard the draft when unpublishing.'),
  });
  const discardDraftInputSchema = z.object({
    locale: runtimeLocaleSchema,
  });

  const tools: DerivedTool[] = [
    {
      name: `cm_${slug}_single_get`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'get' }),
      auth: authFor(uid, ACTIONS.read),
      inputSchema: getInputSchema,
      outputSchema: documentOutputSchema,
      createHandler: createSingleGetHandler(uid),
    },
    {
      name: `cm_${slug}_single_create`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'create' }),
      auth: authFor(uid, ACTIONS.create),
      inputSchema: writeInputSchema,
      outputSchema: documentOutputSchema,
      createHandler: createSingleWriteHandler(uid),
    },
    {
      name: `cm_${slug}_single_update`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'update' }),
      auth: authFor(uid, ACTIONS.update),
      inputSchema: writeInputSchema,
      outputSchema: documentOutputSchema,
      createHandler: createSingleWriteHandler(uid),
    },
    {
      name: `cm_${slug}_single_delete`,
      ...describeTool({ apiID: model.apiID, uid, operation: 'delete' }),
      auth: authFor(uid, ACTIONS.delete),
      inputSchema: deleteInputSchema,
      outputSchema: deleteOutputSchema,
      createHandler: createSingleDeleteHandler(uid),
    },
  ];

  if (draftAndPublish === true) {
    tools.push(
      {
        name: `cm_${slug}_single_publish`,
        ...describeTool({ apiID: model.apiID, uid, operation: 'publish' }),
        auth: authFor(uid, ACTIONS.publish),
        inputSchema: publishInputSchema,
        outputSchema: documentOutputSchema,
        createHandler: createSinglePublishHandler(uid),
      },
      {
        name: `cm_${slug}_single_unpublish`,
        ...describeTool({ apiID: model.apiID, uid, operation: 'unpublish' }),
        auth: authFor(uid, ACTIONS.unpublish),
        inputSchema: unpublishInputSchema,
        outputSchema: documentOutputSchema,
        createHandler: createSingleUnpublishHandler(uid),
      },
      {
        name: `cm_${slug}_single_discard_draft`,
        ...describeTool({ apiID: model.apiID, uid, operation: 'discard_draft' }),
        auth: authFor(uid, ACTIONS.discard),
        inputSchema: discardDraftInputSchema,
        outputSchema: documentOutputSchema,
        createHandler: createSingleDiscardDraftHandler(uid),
      }
    );
  }

  return tools;
};

/**
 * Builds MCP tool definitions for displayed content-manager models.
 * Visibility is enforced separately via static auth on each tool and MCP session capability sync.
 */
export const deriveDisplayedContentTypeMcpToolDefinitions = (
  strapi: Core.Strapi,
  models: ContentManagerModelForMcp[],
  ctx: McpToolsBuildContext = { localeCodes: null }
): DerivedTool[] => {
  const tools: DerivedTool[] = [];

  for (const model of models) {
    if (model.kind === 'collectionType') {
      tools.push(...buildCollectionTools(strapi, model, ctx));
    } else if (model.kind === 'singleType') {
      tools.push(...buildSingleTypeTools(strapi, model, ctx));
    }
  }

  return tools;
};
