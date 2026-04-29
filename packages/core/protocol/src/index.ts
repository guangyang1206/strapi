/**
 * @strapi/protocol — semver-stable constants and Zod schemas shared across Strapi and external tooling.
 *
 * Populated incrementally; see docs/rfcs/protocol-package-and-shared-contracts.md.
 */
export {
  getReservedNames,
  isReservedAttributeName,
  isReservedModelName,
  reservedAttributes,
  reservedModels,
} from './reserved-names';
export { z } from './zod';
