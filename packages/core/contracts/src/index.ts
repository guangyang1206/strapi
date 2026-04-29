/**
 * @strapi/contracts — semver-stable constants and Zod schemas shared across Strapi and external tooling.
 *
 * Populated incrementally; see docs/rfcs/contracts-package-and-shared-contracts.md.
 */
export {
  coreUids,
  DEFAULT_TYPES,
  modelTypes,
  pluginsUids,
  typeKinds,
  VALID_UID_TARGETS,
} from './content-type-grammar';
export {
  getReservedNames,
  isReservedAttributeName,
  isReservedModelName,
  reservedAttributes,
  reservedModels,
} from './reserved-names';
export { z } from './zod';
