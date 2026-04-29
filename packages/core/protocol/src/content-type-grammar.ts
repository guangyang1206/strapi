/**
 * Content-type builder grammar: model/kind labels, default attribute type kinds, and well-known UIDs.
 * Single source for CTB, validation, and tooling (e.g. generators) that must stay in sync.
 */

export const modelTypes = {
  CONTENT_TYPE: 'CONTENT_TYPE',
  COMPONENT: 'COMPONENT',
} as const;

export const typeKinds = {
  SINGLE_TYPE: 'singleType',
  COLLECTION_TYPE: 'collectionType',
} as const;

export const DEFAULT_TYPES = [
  // advanced types
  'media',

  // scalar types
  'string',
  'text',
  'richtext',
  'blocks',
  'json',
  'enumeration',
  'password',
  'email',
  'integer',
  'biginteger',
  'float',
  'decimal',
  'date',
  'time',
  'datetime',
  'timestamp',
  'boolean',

  'relation',
] as const;

export const VALID_UID_TARGETS = ['string', 'text'] as const;

export const coreUids = {
  STRAPI_USER: 'admin::user',
  PREFIX: 'strapi::',
} as const;

export const pluginsUids = {
  UPLOAD_FILE: 'plugin::upload.file',
} as const;
