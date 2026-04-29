import { snakeCase } from 'lodash/fp';

/**
 * Reserved attribute names for user-defined schema fields (compare using snake_case — persisted column style).
 * Prefix entries ending with `*` match any name starting with that prefix (without the asterisk).
 */
export const reservedAttributes: readonly string[] = [
  // ID fields
  'id',
  'document_id',

  // Creator fields
  'created_at',
  'updated_at',
  'published_at',
  // V6: add first_published_at when it becomes the default behaviour
  'created_by_id',
  'updated_by_id',
  // does not actually conflict because the fields are called *_by_id but we'll leave it to avoid confusion
  'created_by',
  'updated_by',

  // Used for Strapi functionality
  'entry_id',
  'status',
  'localizations',
  'meta',
  'locale',
  '__component',
  '__contentType',

  // Prefix rules
  'strapi*',
  '_strapi*',
  '__strapi*',
];

/**
 * Reserved model / collection names (compare using snake_case).
 */
export const reservedModels: readonly string[] = [
  'boolean',
  'date',
  'date_time',
  'time',
  'upload',
  'document',
  'then', // no longer an issue but still restricting for being a javascript keyword

  'strapi*',
  '_strapi*',
  '__strapi*',
];

export const getReservedNames = () => ({
  models: reservedModels,
  attributes: reservedAttributes,
});

/** True if `name` is reserved for a content-type or component model name. */
export const isReservedModelName = (name: string): boolean => {
  const snakeCaseName = snakeCase(name);
  if (reservedModels.includes(snakeCaseName)) {
    return true;
  }

  if (
    reservedModels
      .filter((key) => key.endsWith('*'))
      .map((key) => key.slice(0, -1))
      .some((prefix) => snakeCaseName.startsWith(prefix))
  ) {
    return true;
  }

  return false;
};

/** True if `name` is reserved for an attribute on a content type or component. */
export const isReservedAttributeName = (name: string): boolean => {
  const snakeCaseName = snakeCase(name);
  if (reservedAttributes.includes(snakeCaseName)) {
    return true;
  }

  if (
    reservedAttributes
      .filter((key) => key.endsWith('*'))
      .map((key) => key.slice(0, -1))
      .some((prefix) => snakeCaseName.startsWith(prefix))
  ) {
    return true;
  }

  return false;
};
