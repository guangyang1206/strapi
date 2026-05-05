import {
  deriveDisplayedContentTypeMcpToolDefinitions,
  buildDataSchema,
  buildSortSchema,
  buildFiltersSchema,
  slugifyUidForMcpToolName,
  type ContentManagerModelForMcp,
} from '../derive-content-type-mcp-tools';
import { ACTIONS } from '../../services/permission-checker';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockStrapi = {
  get: jest.fn(() => ({ get: jest.fn(() => undefined) })),
} as any;

const baseModel = (overrides: Partial<ContentManagerModelForMcp>): ContentManagerModelForMcp => ({
  uid: 'api::article.article',
  kind: 'collectionType',
  apiID: 'article',
  options: {},
  attributes: {},
  ...overrides,
});

const makeUserAbility = (canResult = true) => ({
  can: jest.fn(() => canResult),
  cannot: jest.fn(() => !canResult),
  rulesFor: jest.fn(() => []),
});

const makePermissionChecker = (overrides: Record<string, jest.Mock> = {}) => ({
  cannot: {
    read: jest.fn(() => false),
    create: jest.fn(() => false),
    update: jest.fn(() => false),
    delete: jest.fn(() => false),
    publish: jest.fn(() => false),
    unpublish: jest.fn(() => false),
    discard: jest.fn(() => false),
  },
  can: {
    read: jest.fn(() => true),
    create: jest.fn(() => true),
    update: jest.fn(() => true),
  },
  sanitizeOutput: jest.fn((doc: unknown) => Promise.resolve(doc)),
  sanitizeCreateInput: jest.fn((data: unknown) => Promise.resolve(data)),
  sanitizeUpdateInput: jest.fn(() => jest.fn((data: unknown) => Promise.resolve(data))),
  sanitizedQuery: {
    read: jest.fn((q: unknown) => Promise.resolve(q)),
    update: jest.fn((q: unknown) => Promise.resolve(q)),
    delete: jest.fn((q: unknown) => Promise.resolve(q)),
    publish: jest.fn((q: unknown) => Promise.resolve(q)),
    unpublish: jest.fn((q: unknown) => Promise.resolve(q)),
    discard: jest.fn((q: unknown) => Promise.resolve(q)),
  },
  requiresEntity: { read: jest.fn(() => false) },
  ...overrides,
});

const makeDocumentManager = (overrides: Record<string, jest.Mock> = {}) => ({
  findPage: jest.fn(() =>
    Promise.resolve({ results: [], pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } })
  ),
  findOne: jest.fn(() => Promise.resolve(null)),
  findMany: jest.fn(() => Promise.resolve([])),
  findLocales: jest.fn(() => Promise.resolve([])),
  exists: jest.fn(() => Promise.resolve(false)),
  create: jest.fn(() => Promise.resolve({ documentId: 'doc-1' })),
  update: jest.fn(() => Promise.resolve({ documentId: 'doc-1' })),
  delete: jest.fn(() => Promise.resolve({})),
  publish: jest.fn(() => Promise.resolve([{ documentId: 'doc-1' }])),
  unpublish: jest.fn(() => Promise.resolve({ documentId: 'doc-1' })),
  discardDraft: jest.fn(() => Promise.resolve({ documentId: 'doc-1' })),
  ...overrides,
});

const makeDocumentMetadata = () => ({
  getManyAvailableStatus: jest.fn(() => Promise.resolve([])),
  getStatus: jest.fn(() => 'draft'),
  formatDocumentWithMetadata: jest.fn((uid: string, doc: unknown) =>
    Promise.resolve({ ...(doc as object), meta: {} })
  ),
});

const makePopulateBuilder = () => {
  const builder = {
    populateFromQuery: jest.fn().mockReturnThis(),
    populateDeep: jest.fn().mockReturnThis(),
    countRelations: jest.fn().mockReturnThis(),
    withPopulateOverride: jest.fn().mockReturnThis(),
    build: jest.fn(() => Promise.resolve({})),
  };
  return jest.fn(() => builder);
};

// ---------------------------------------------------------------------------
// Global mock setup
// ---------------------------------------------------------------------------

// We mock at module level so handlers can use getService internally.
const mockPermissionChecker = makePermissionChecker();
const mockDocumentManager = makeDocumentManager();
const mockDocumentMetadata = makeDocumentMetadata();
const mockPopulateBuilder = makePopulateBuilder();

jest.mock('../../utils', () => ({
  getService: jest.fn((name: string) => {
    if (name === 'permission-checker') {
      return { create: jest.fn(() => mockPermissionChecker) };
    }
    if (name === 'document-manager') {
      return mockDocumentManager;
    }
    if (name === 'document-metadata') {
      return mockDocumentMetadata;
    }
    if (name === 'populate-builder') {
      return mockPopulateBuilder;
    }
    throw new Error(`Unknown service: ${name}`);
  }),
}));

jest.mock('../../controllers/validation/dimensions', () => ({
  getDocumentLocaleAndStatus: jest.fn(({ locale, status }: any) =>
    Promise.resolve({ locale: locale ?? 'en', status: status ?? 'draft' })
  ),
}));

jest.mock('../../controllers/utils/metadata', () => ({
  formatDocumentWithMetadata: jest.fn((_checker: unknown, _uid: unknown, doc: unknown) =>
    Promise.resolve({ data: doc, meta: {} })
  ),
}));

jest.mock('../../controllers/utils/document-status', () => ({
  indexByDocumentId: jest.fn(() => new Map()),
}));

jest.mock('../../services/utils/populate', () => ({
  getPopulateForLocalizations: jest.fn(() => ({})),
}));

jest.mock('@strapi/utils', () => {
  const actual = jest.requireActual('@strapi/utils');
  return {
    ...actual,
    errors: {
      ForbiddenError: class ForbiddenError extends Error {
        constructor(message = 'Forbidden') {
          super(message);
          this.name = 'ForbiddenError';
        }
      },
      NotFoundError: class NotFoundError extends Error {
        constructor(message = 'Not Found') {
          super(message);
          this.name = 'NotFoundError';
        }
      },
      ValidationError: class ValidationError extends Error {
        constructor(message = 'Validation Error') {
          super(message);
          this.name = 'ValidationError';
        }
      },
    },
    contentTypes: {
      hasDraftAndPublish: jest.fn(() => false),
      // Mirror the real isWritableAttribute: exclude id, documentId, and attrs with writable: false
      isWritableAttribute: jest.fn(
        (model: { attributes: Record<string, { writable?: boolean }> }, key: string) => {
          const SYSTEM_KEYS = new Set([
            'id',
            'documentId',
            'createdAt',
            'updatedAt',
            'publishedAt',
          ]);
          if (SYSTEM_KEYS.has(key) === true) return false;
          const attr = model.attributes?.[key];
          return attr === undefined || attr.writable !== false;
        }
      ),
      isPrivateAttribute: jest.fn(
        (model: { attributes: Record<string, { private?: boolean }> }, key: string) =>
          model?.attributes?.[key]?.private === true
      ),
    },
    async: {
      map: jest.fn(async (arr: unknown[], fn: (item: unknown) => Promise<unknown>) =>
        Promise.all(arr.map(fn))
      ),
      pipe:
        (...fns: Array<(v: unknown) => unknown>) =>
        (v: unknown) =>
          fns.reduce(async (acc, fn) => fn(await acc), Promise.resolve(v)),
    },
  };
});

// ---------------------------------------------------------------------------
// Tool structure tests (unchanged from original)
// ---------------------------------------------------------------------------

describe('deriveDisplayedContentTypeMcpToolDefinitions', () => {
  it('maps uid segments into a stable tool name slug', () => {
    expect(slugifyUidForMcpToolName('api::article.article')).toBe('api_article');
  });

  it('emits list/get with explorer.read for a collection type', () => {
    const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [baseModel({})]);
    const list = tools.find((t) => t.name === 'cm_api_article_list');
    const get = tools.find((t) => t.name === 'cm_api_article_get');

    expect(list).toBeDefined();
    expect(get).toBeDefined();
    expect(list?.auth).toEqual({ action: ACTIONS.read, subject: 'api::article.article' });
    expect(get?.auth).toEqual({ action: ACTIONS.read, subject: 'api::article.article' });
  });

  it('adds publish, unpublish, and discard_draft when draft and publish is enabled', () => {
    const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [
      baseModel({ options: { draftAndPublish: true } }),
    ]);

    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'cm_api_article_publish',
        'cm_api_article_unpublish',
        'cm_api_article_discard_draft',
      ])
    );

    const discard = tools.find((t) => t.name === 'cm_api_article_discard_draft');
    const publish = tools.find((t) => t.name === 'cm_api_article_publish');

    expect(discard?.auth.action).toBe(ACTIONS.discard);
    expect(publish?.auth.action).toBe(ACTIONS.publish);
  });

  it('omits draft workflow tools when draft and publish is disabled', () => {
    const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [
      baseModel({ options: { draftAndPublish: false } }),
    ]);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('cm_api_article_publish');
    expect(names).not.toContain('cm_api_article_discard_draft');
  });

  it('uses single-type tool names and separate create/update gates', () => {
    const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [
      baseModel({ kind: 'singleType', uid: 'api::global.global', apiID: 'global' }),
    ]);
    const names = tools.map((t) => t.name);
    expect(names).toContain('cm_api_global_single_get');
    expect(names).toContain('cm_api_global_single_create');
    expect(names).toContain('cm_api_global_single_update');
    expect(names).not.toContain('cm_api_global_list');

    const create = tools.find((t) => t.name === 'cm_api_global_single_create');
    const update = tools.find((t) => t.name === 'cm_api_global_single_update');
    expect(create?.auth.action).toBe(ACTIONS.create);
    expect(update?.auth.action).toBe(ACTIONS.update);
  });
});

// ---------------------------------------------------------------------------
// Input / output schema tests
// ---------------------------------------------------------------------------

describe('tool input schemas', () => {
  const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [
    baseModel({ options: { draftAndPublish: true } }),
  ]);

  const findTool = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`Tool "${name}" not found`);
    return tool;
  };

  it('list tool accepts optional locale, status, page, pageSize, sort, filters', () => {
    const schema = findTool('cm_api_article_list').inputSchema;
    const shape = schema.shape;
    expect(shape.locale).toBeDefined();
    expect(shape.status).toBeDefined();
    expect(shape.page).toBeDefined();
    expect(shape.pageSize).toBeDefined();
    expect(shape.sort).toBeDefined();
    expect(shape.filters).toBeDefined();
  });

  it('get tool requires documentId, accepts optional locale and status', () => {
    const schema = findTool('cm_api_article_get').inputSchema;
    const shape = schema.shape;
    expect(shape.documentId).toBeDefined();
    expect(shape.locale).toBeDefined();
    expect(shape.status).toBeDefined();
    // documentId must be present (no optional())
    const result = schema.safeParse({ locale: 'en' });
    expect(result.success).toBe(false);
  });

  it('documentId argument description clarifies canonical identity across versions', () => {
    const schema = findTool('cm_api_article_get').inputSchema;
    const documentIdDescription = (schema.shape.documentId as { description?: string }).description;

    expect(documentIdDescription).toContain('Stable document ID');
    expect(documentIdDescription).toContain('canonical identifier');
  });

  it('create tool requires data', () => {
    const schema = findTool('cm_api_article_create').inputSchema;
    const result = schema.safeParse({ locale: 'en' }); // missing data
    expect(result.success).toBe(false);
  });

  it('update tool requires documentId and data', () => {
    const schema = findTool('cm_api_article_update').inputSchema;
    expect(schema.safeParse({ documentId: 'abc', data: {} }).success).toBe(true);
    expect(schema.safeParse({ data: {} }).success).toBe(false); // missing documentId
  });

  it('unpublish tool accepts optional discardDraft boolean', () => {
    const schema = findTool('cm_api_article_unpublish').inputSchema;
    expect(schema.safeParse({ documentId: 'abc', discardDraft: true }).success).toBe(true);
    expect(schema.safeParse({ documentId: 'abc', discardDraft: 'yes' }).success).toBe(false);
  });

  it('uses locale enum when localeCodes are provided in build context', () => {
    const toolsWithLocales = deriveDisplayedContentTypeMcpToolDefinitions(
      mockStrapi,
      [baseModel({})],
      { localeCodes: ['en', 'fr'] }
    );
    const getSchema = toolsWithLocales.find(
      (tool) => tool.name === 'cm_api_article_get'
    )?.inputSchema;

    if (getSchema === undefined) {
      throw new Error('Tool "cm_api_article_get" not found');
    }

    expect(getSchema.safeParse({ documentId: 'abc', locale: 'en' }).success).toBe(true);
    expect(getSchema.safeParse({ documentId: 'abc', locale: 'de' }).success).toBe(false);
  });

  it('falls back to generic locale string when localeCodes are null', () => {
    const toolsWithoutLocales = deriveDisplayedContentTypeMcpToolDefinitions(
      mockStrapi,
      [baseModel({})],
      { localeCodes: null }
    );
    const getSchema = toolsWithoutLocales.find(
      (tool) => tool.name === 'cm_api_article_get'
    )?.inputSchema;

    if (getSchema === undefined) {
      throw new Error('Tool "cm_api_article_get" not found');
    }

    expect(getSchema.safeParse({ documentId: 'abc', locale: 'de' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handler behavior tests
// ---------------------------------------------------------------------------

describe('collection-type handler: list', () => {
  const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [baseModel({})]);
  const listTool = tools.find((t) => t.name === 'cm_api_article_list')!;

  const strapi = { getModel: jest.fn(() => ({})) } as any;
  const context = { userAbility: makeUserAbility() };

  beforeEach(() => jest.clearAllMocks());

  it('returns empty results when documentManager.findPage returns nothing', async () => {
    const handler = listTool.createHandler(strapi, context);
    const result = await handler({ locale: 'en', status: 'draft' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      results: [],
      pagination: { page: 1, pageSize: 25, total: 0 },
    });
  });

  it('throws ForbiddenError when user cannot read', async () => {
    mockPermissionChecker.cannot.read.mockReturnValueOnce(true);
    const handler = listTool.createHandler(strapi, context);
    await expect(handler({ locale: 'en' })).rejects.toThrow('Forbidden');
  });
});

describe('collection-type handler: get', () => {
  const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [baseModel({})]);
  const getTool = tools.find((t) => t.name === 'cm_api_article_get')!;

  const strapi = {} as any;
  const context = { userAbility: makeUserAbility() };

  beforeEach(() => jest.clearAllMocks());

  it('throws NotFoundError when document does not exist', async () => {
    mockDocumentManager.findOne.mockResolvedValueOnce(null);
    mockDocumentManager.exists.mockResolvedValueOnce(false);

    const handler = getTool.createHandler(strapi, context);
    await expect(handler({ documentId: 'missing', locale: 'en' })).rejects.toThrow('Not Found');
  });

  it('returns document data when found', async () => {
    const doc = { documentId: 'abc', title: 'Hello' };
    mockDocumentManager.findOne.mockResolvedValueOnce(doc as never);

    const handler = getTool.createHandler(strapi, context);
    const result = await handler({ documentId: 'abc', locale: 'en' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ data: doc });
  });

  it('throws ForbiddenError when user cannot read', async () => {
    mockPermissionChecker.cannot.read.mockReturnValueOnce(true);
    const handler = getTool.createHandler(strapi, context);
    await expect(handler({ documentId: 'abc' })).rejects.toThrow('Forbidden');
  });
});

describe('collection-type handler: create', () => {
  const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [baseModel({})]);
  const createTool = tools.find((t) => t.name === 'cm_api_article_create')!;

  const strapi = {} as any;
  const context = { userAbility: makeUserAbility() };

  beforeEach(() => jest.clearAllMocks());

  it('throws ForbiddenError when user cannot create', async () => {
    mockPermissionChecker.cannot.create.mockReturnValueOnce(true);
    const handler = createTool.createHandler(strapi, context);
    await expect(handler({ data: { title: 'x' } })).rejects.toThrow('Forbidden');
  });

  it('calls documentManager.create with sanitized data', async () => {
    const handler = createTool.createHandler(strapi, context);
    await handler({ data: { title: 'Hello' }, locale: 'en' });

    expect(mockDocumentManager.create).toHaveBeenCalled();
  });
});

describe('collection-type handler: delete', () => {
  const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [baseModel({})]);
  const deleteTool = tools.find((t) => t.name === 'cm_api_article_delete')!;

  const strapi = {} as any;
  const context = { userAbility: makeUserAbility() };

  beforeEach(() => jest.clearAllMocks());

  it('throws ForbiddenError when user cannot delete', async () => {
    mockPermissionChecker.cannot.delete.mockReturnValueOnce(true);
    const handler = deleteTool.createHandler(strapi, context);
    await expect(handler({ documentId: 'abc', locale: 'en' })).rejects.toThrow('Forbidden');
  });

  it('throws NotFoundError when no locales found', async () => {
    mockDocumentManager.findLocales.mockResolvedValueOnce([]);
    const handler = deleteTool.createHandler(strapi, context);
    await expect(handler({ documentId: 'abc', locale: 'en' })).rejects.toThrow('Not Found');
  });

  it('calls documentManager.delete when locale exists', async () => {
    mockDocumentManager.findLocales.mockResolvedValueOnce([{ documentId: 'abc' }] as never);
    const handler = deleteTool.createHandler(strapi, context);
    await handler({ documentId: 'abc', locale: 'en' });
    expect(mockDocumentManager.delete).toHaveBeenCalled();
  });
});

describe('single-type handler: single_get', () => {
  const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [
    baseModel({ kind: 'singleType', uid: 'api::global.global', apiID: 'global' }),
  ]);
  const getTool = tools.find((t) => t.name === 'cm_api_global_single_get')!;

  const strapi = {} as any;
  const context = { userAbility: makeUserAbility() };

  beforeEach(() => jest.clearAllMocks());

  it('throws ForbiddenError when user cannot read', async () => {
    mockPermissionChecker.cannot.read.mockReturnValueOnce(true);
    const handler = getTool.createHandler(strapi, context);
    await expect(handler({ locale: 'en' })).rejects.toThrow('Forbidden');
  });
});

describe('tool annotations', () => {
  const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [
    baseModel({ options: { draftAndPublish: true } }),
  ]);

  it('all tools have a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('all tools have a valid auth object with action and subject', () => {
    for (const tool of tools) {
      expect(tool.auth.action).toBeTruthy();
      expect(tool.auth.subject).toBeTruthy();
    }
  });

  it('all tools expose inputSchema and outputSchema as Zod objects', () => {
    for (const tool of tools) {
      expect(typeof tool.inputSchema.safeParse).toBe('function');
      expect(typeof tool.outputSchema.safeParse).toBe('function');
    }
  });

  it('all tools expose a createHandler factory function', () => {
    for (const tool of tools) {
      expect(typeof tool.createHandler).toBe('function');
    }
  });

  it('publish/unpublish/discard descriptions clarify stable document identity', () => {
    const publish = tools.find((tool) => tool.name === 'cm_api_article_publish');
    const unpublish = tools.find((tool) => tool.name === 'cm_api_article_unpublish');
    const discardDraft = tools.find((tool) => tool.name === 'cm_api_article_discard_draft');

    expect(publish?.description).toContain('documentId');
    expect(publish?.description).toContain('different numeric id');
    expect(unpublish?.description).toContain('documentId');
    expect(unpublish?.description).toContain('different numeric id');
    expect(discardDraft?.description).toContain('stable identity');
  });
});

// ---------------------------------------------------------------------------
// buildDataSchema tests
// ---------------------------------------------------------------------------

/** Helper: build a minimal model object for isWritableAttribute calls in tests. */
const makeModel = (attrs: Record<string, unknown>) => ({ attributes: attrs }) as any;

describe('buildDataSchema', () => {
  it('accepts an empty attributes object and produces a strict empty schema', () => {
    const schema = buildDataSchema(mockStrapi, makeModel({}), {});
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ unknownKey: 'x' }).success).toBe(false);
  });

  it('maps string attribute to z.string()', () => {
    const attrs = { title: { type: 'string' } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ title: 'hello' }).success).toBe(true);
    expect(schema.safeParse({ title: 123 }).success).toBe(false);
  });

  it('maps integer attribute to z.number().int()', () => {
    const attrs = { count: { type: 'integer' } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ count: 5 }).success).toBe(true);
    expect(schema.safeParse({ count: 5.5 }).success).toBe(false);
    expect(schema.safeParse({ count: 'five' }).success).toBe(false);
  });

  it('maps boolean attribute to z.boolean()', () => {
    const attrs = { active: { type: 'boolean' } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ active: true }).success).toBe(true);
    expect(schema.safeParse({ active: 'yes' }).success).toBe(false);
  });

  it('maps enumeration to z.enum([...]) with known values', () => {
    const attrs = {
      status: { type: 'enumeration', enum: ['draft', 'published', 'archived'] },
    } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ status: 'draft' }).success).toBe(true);
    expect(schema.safeParse({ status: 'invalid' }).success).toBe(false);
  });

  it('makes required attributes required in the schema', () => {
    const attrs = { title: { type: 'string', required: true } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ title: 'hello' }).success).toBe(true);
  });

  it('makes non-required attributes optional', () => {
    const attrs = { title: { type: 'string', required: false } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ title: 'hello' }).success).toBe(true);
  });

  it('excludes system keys (id, documentId, createdAt, updatedAt, publishedAt) via isWritableAttribute', () => {
    const attrs = {
      id: { type: 'integer' },
      documentId: { type: 'string' },
      createdAt: { type: 'datetime' },
      updatedAt: { type: 'datetime' },
      publishedAt: { type: 'datetime' },
      createdBy: { type: 'relation', writable: false } as any,
      updatedBy: { type: 'relation', writable: false } as any,
      title: { type: 'string' },
    } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    // Only title should be writable
    expect(schema.safeParse({ title: 'hello' }).success).toBe(true);
    // System keys must be rejected (strict mode excludes them from the shape entirely)
    expect(schema.safeParse({ title: 'hello', id: 1 }).success).toBe(false);
    expect(schema.safeParse({ title: 'hello', documentId: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ title: 'hello', createdAt: '2024-01-01' }).success).toBe(false);
  });

  it('rejects unknown keys (strict mode — MCP boundary enforces field names)', () => {
    const attrs = { title: { type: 'string' } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ title: 'hello', unknownField: 'x' }).success).toBe(false);
    expect(schema.safeParse({ title: 'hello' }).success).toBe(true);
  });

  it('derives per-ct schema that rejects wrong type on known field', () => {
    const attrs = { count: { type: 'integer', required: true } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ count: 'not-a-number' }).success).toBe(false);
  });

  it('carries minLength / maxLength constraints on string attributes', () => {
    const attrs = { slug: { type: 'string', minLength: 3, maxLength: 50, required: true } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ slug: 'ab' }).success).toBe(false); // too short
    expect(schema.safeParse({ slug: 'abc' }).success).toBe(true);
  });

  it('maps relation attribute to non-empty string schema (Strapi document ID, not UUID)', () => {
    const attrs = { author: { type: 'relation', relation: 'manyToOne' } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    // Strapi document IDs are nanoid-style (e.g. "z7v8zma53x01r6oceimv922b"), never UUID format.
    expect(schema.safeParse({ author: 'z7v8zma53x01r6oceimv922b' }).success).toBe(true);
    expect(schema.safeParse({ author: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true);
    expect(schema.safeParse({ author: '' }).success).toBe(false);
    expect(schema.safeParse({ author: 123 }).success).toBe(false);
  });

  it('maps media attribute to z.any()', () => {
    const attrs = { cover: { type: 'media', multiple: false } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ cover: { id: 1 } }).success).toBe(true);
  });

  it('maps component attribute to z.any()', () => {
    const attrs = { seo: { type: 'component', component: 'shared.seo' } } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ seo: { title: 'x' } }).success).toBe(true);
  });

  it('per-ct create tool uses derived data schema', () => {
    const model = baseModel({
      attributes: {
        title: { type: 'string', required: true },
        age: { type: 'integer' },
      } as any,
    });
    const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [model]);
    const createTool = tools.find((t) => t.name === 'cm_api_article_create')!;

    expect(createTool.inputSchema.safeParse({ data: { title: 'Hi' } }).success).toBe(true);
    expect(createTool.inputSchema.safeParse({ data: {} }).success).toBe(false); // title required
    expect(createTool.inputSchema.safeParse({ data: { title: 'Hi', age: 'old' } }).success).toBe(
      false
    ); // age must be int
  });

  it('excludes private attributes (private: true) from the data schema', () => {
    const attrs = {
      title: { type: 'string' },
      secret: { type: 'string', private: true },
      password: { type: 'password', private: true },
    } as any;
    const schema = buildDataSchema(mockStrapi, makeModel(attrs), attrs);
    expect(schema.safeParse({ title: 'hello' }).success).toBe(true);
    expect(schema.safeParse({ title: 'hello', secret: 'value' }).success).toBe(false);
    expect(schema.safeParse({ title: 'hello', password: 'pass' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSortSchema tests
// ---------------------------------------------------------------------------

describe('buildSortSchema', () => {
  const attrs = {
    title: { type: 'string' },
    count: { type: 'integer' },
    status: { type: 'enumeration', enum: ['draft', 'published'] },
    body: { type: 'relation' }, // non-scalar — must be excluded
  } as any;

  it('returns z.never() when there are no scalar attributes', () => {
    const schema = buildSortSchema({ body: { type: 'relation' } } as any);
    expect(schema.safeParse('title').success).toBe(false);
    expect(schema.safeParse(undefined).success).toBe(false);
  });

  it('accepts a string sort expression', () => {
    const schema = buildSortSchema(attrs);
    expect(schema.safeParse('title:asc').success).toBe(true);
    expect(schema.safeParse('count:desc').success).toBe(true);
  });

  it('accepts an array of strings', () => {
    const schema = buildSortSchema(attrs);
    expect(schema.safeParse(['title:asc', 'count:desc']).success).toBe(true);
  });

  it('accepts an object with direction values for known scalar fields', () => {
    const schema = buildSortSchema(attrs);
    expect(schema.safeParse({ title: 'asc' }).success).toBe(true);
    expect(schema.safeParse({ count: 'desc' }).success).toBe(true);
  });

  it('accepts an array of sort objects', () => {
    const schema = buildSortSchema(attrs);
    expect(schema.safeParse([{ title: 'asc' }, { count: 'desc' }]).success).toBe(true);
  });

  it('rejects an object direction value other than asc/desc', () => {
    const schema = buildSortSchema(attrs);
    expect(schema.safeParse({ title: 'random' }).success).toBe(false);
  });

  it('is optional — undefined is valid', () => {
    const schema = buildSortSchema(attrs);
    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it('list tool sort field is constrained to scalar attributes', () => {
    const model = baseModel({ attributes: attrs });
    const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [model]);
    const listTool = tools.find((t) => t.name === 'cm_api_article_list')!;
    const schema = listTool.inputSchema;

    expect(schema.safeParse({ sort: 'title:asc' }).success).toBe(true);
    expect(schema.safeParse({ sort: { title: 'asc', count: 'desc' } }).success).toBe(true);
    expect(schema.safeParse({ sort: [{ title: 'asc' }] }).success).toBe(true);
  });

  it('excludes private scalar fields from sort schema description and object shape', () => {
    const schema = buildSortSchema({
      title: { type: 'string' },
      secret: { type: 'string', private: true },
    } as any);
    // Private field must not appear in the schema description surfaced to the AI
    expect(schema.description).not.toContain('secret');
    expect(schema.description).toContain('title');
  });
});

// ---------------------------------------------------------------------------
// buildFiltersSchema tests
// ---------------------------------------------------------------------------

describe('buildFiltersSchema', () => {
  const attrs = {
    title: { type: 'string' },
    count: { type: 'integer' },
    active: { type: 'boolean' },
    status: { type: 'enumeration', enum: ['draft', 'published'] },
    body: { type: 'relation' }, // non-scalar — excluded
  } as any;

  it('returns z.never() when there are no scalar attributes', () => {
    const schema = buildFiltersSchema({ body: { type: 'relation' } } as any);
    expect(schema.safeParse({ title: { $eq: 'x' } }).success).toBe(false);
  });

  it('is optional — undefined is valid', () => {
    const schema = buildFiltersSchema(attrs);
    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it('accepts a simple field equality filter', () => {
    const schema = buildFiltersSchema(attrs);
    expect(schema.safeParse({ title: { $eq: 'hello' } }).success).toBe(true);
  });

  it('accepts $contains operator on string field', () => {
    const schema = buildFiltersSchema(attrs);
    expect(schema.safeParse({ title: { $contains: 'foo' } }).success).toBe(true);
  });

  it('accepts $gt/$lt operators on integer field', () => {
    const schema = buildFiltersSchema(attrs);
    expect(schema.safeParse({ count: { $gt: 5 } }).success).toBe(true);
    expect(schema.safeParse({ count: { $lt: 100 } }).success).toBe(true);
  });

  it('accepts $and with nested filter objects', () => {
    const schema = buildFiltersSchema(attrs);
    expect(
      schema.safeParse({
        $and: [{ title: { $contains: 'foo' } }, { count: { $gt: 5 } }],
      }).success
    ).toBe(true);
  });

  it('accepts $or with nested filter objects', () => {
    const schema = buildFiltersSchema(attrs);
    expect(
      schema.safeParse({
        $or: [{ title: { $eq: 'a' } }, { title: { $eq: 'b' } }],
      }).success
    ).toBe(true);
  });

  it('accepts $not wrapping a filter object', () => {
    const schema = buildFiltersSchema(attrs);
    expect(schema.safeParse({ $not: { title: { $eq: 'forbidden' } } }).success).toBe(true);
  });

  it('accepts direct value (implicit $eq) on field', () => {
    const schema = buildFiltersSchema(attrs);
    expect(schema.safeParse({ title: 'hello' }).success).toBe(true);
  });

  it('accepts enumeration value in filter', () => {
    const schema = buildFiltersSchema(attrs);
    expect(schema.safeParse({ status: { $eq: 'draft' } }).success).toBe(true);
  });

  it('accepts boolean value in filter', () => {
    const schema = buildFiltersSchema(attrs);
    expect(schema.safeParse({ active: { $eq: true } }).success).toBe(true);
    expect(schema.safeParse({ active: true }).success).toBe(true);
    expect(schema.safeParse({ active: 'yes' }).success).toBe(false);
  });

  it('list tool filters are wired into the input schema', () => {
    const model = baseModel({ attributes: attrs });
    const tools = deriveDisplayedContentTypeMcpToolDefinitions(mockStrapi, [model]);
    const listTool = tools.find((t) => t.name === 'cm_api_article_list')!;
    const schema = listTool.inputSchema;

    expect(schema.safeParse({ filters: { title: { $contains: 'foo' } } }).success).toBe(true);
    expect(schema.safeParse({ filters: { $and: [{ title: { $eq: 'x' } }] } }).success).toBe(true);
  });

  it('excludes private scalar fields from filters schema description', () => {
    const schema = buildFiltersSchema({
      title: { type: 'string' },
      secret: { type: 'string', private: true },
    } as any);
    // Private field must not appear in the schema description surfaced to the AI
    expect(schema.description).not.toContain('secret');
    expect(schema.description).toContain('title');
  });
});
