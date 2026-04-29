---
title: Introduction
slug: /contracts
tags:
  - contracts
  - monorepo
---

# Contracts (`@strapi/contracts`)

**`@strapi/contracts`** is a small, **semver-stable** package for **normative** Strapi rules that should be shareable without pulling the full framework: reserved names, content-type **grammar** (default attribute kinds, model/collection kinds, well-known UIDs), and Zod-oriented entry points. It is intended for Strapi packages, **CLIs, SDKs, and external services** (e.g. validation that must match the CMS) that need the same constants and schemas the server uses.

**Code location:** `packages/core/contracts/`

---

## How it fits: three layers

Strapi intentionally **does not** put every shared thing in one package. Use this split:

| Layer                | Package             | Role                                                                                                                                                                                                                                                    |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contracts**        | `@strapi/contracts` | Runtime **constants**, **predicates**, and **Zod** (or `z` re-exports) that answer: _“What does Strapi accept on the wire or in user-defined schema?”_ **Minimal dependencies**; must **not** import Strapi core, admin, or heavy framework code.       |
| **Structural types** | `@strapi/types`     | **TypeScript** shapes for the framework, plugins, and registries. Prefer **type-only** usage where possible.                                                                                                                                            |
| **Mechanics**        | `@strapi/utils`     | **Sanitize** / **validate** visitors, generic helpers, `validateZod`, etc. **Not** the home for normative “what is allowed” lists—those belong in **`@strapi/contracts`** so `utils` can depend on **`@strapi/contracts`** without inverting the graph. |

### Dependency boundaries (Mermaid)

This documentation site already enables **Mermaid** (`@docusaurus/theme-mermaid` and `markdown.mermaid` in `docs/docusaurus.config.js`), like other Core pages (for example [Permissions](/permissions)).

**Allowed dependency direction** (arrows point from **importer** to **imported** package):

```mermaid
flowchart TB
  FW["Framework & plugins<br/>(e.g. @strapi/strapi, admin, CTB, plugins)"]
  CONTRACTS["@strapi/contracts"]
  UTILS["@strapi/utils"]
  TYPES["@strapi/types"]
  FW --> CONTRACTS
  FW --> UTILS
  FW --> TYPES
  UTILS --> CONTRACTS
```

Framework and plugins consume **`@strapi/contracts`**, **utils**, and **types**. **`@strapi/utils` may depend on `@strapi/contracts`** when reusing normative constants or predicates (keep a single source of truth in this package).

**Must not exist** — **`@strapi/contracts`** must remain a **leaf** relative to other Strapi packages (no imports of `@strapi/utils`, `@strapi/types`, `@strapi/core`, admin, plugins, etc.):

```mermaid
flowchart LR
  subgraph forbidden["Invalid dependencies — do not add"]
    CONTRACTS["@strapi/contracts"]
    UTILS["@strapi/utils"]
    TYPES["@strapi/types"]
    CORE["@strapi/core / admin / …"]
    CONTRACTS --> UTILS
    CONTRACTS --> TYPES
    CONTRACTS --> CORE
  end
```

:::note

**Reality check from `package.json`:** **`@strapi/contracts`** only pulls third-party libraries (for example `zod`, `lodash`). **`@strapi/utils`** also declares **no** `@strapi/*` runtime dependencies — keep it that way for generic helpers. **`@strapi/types`** is different: it **does** depend on several `@strapi/*` packages for structural typings; that does **not** change the rule that **`@strapi/contracts`** stays dependency-light for external consumers.

:::

---

## What belongs in `@strapi/contracts`

Add or promote code here when **several** of the following are true:

- The value is part of a **user-facing** or **API** contract (schema grammar, reserved identifiers, stable query/body keys you want externals to validate the same way).
- **Third parties** (SDK, AI service, doc generator) should be able to `npm install @strapi/contracts` and stay aligned with a **specific Strapi release** (pin the same version as other `@strapi/*` packages in the app).
- It should **not** drag in the admin UI, Koa server, or database layer.

**Keep in the owning package** when the concern is **internal** or **feature-local**, for example:

- **Storage / migrations** internals (e.g. reserved **system** table names for the DB diff) — stay in `@strapi/database` unless you explicitly design a published storage contract.
- **Admin** routes, cookies, feature flags, or **plugin-only** UIDs that are not part of the generic shared contract surface.
- **Implementation details** of sanitization (traversal keys, visitor wiring) — stay in `@strapi/utils`; share only the **allowlists** or **predicates** via **`@strapi/contracts`** if they are normative.

Naming note: CTB and schema UIs often use **snake_case** normalisation for reserved checks; Content API payloads use **camelCase** field names (`@strapi/utils` / `content-types.ts`). **`@strapi/contracts`** may hold both **concepts**; use **explicit mapping** between layers instead of one flat string list for everything.

---

## Package exports

The package uses conditional **`exports`** (see `packages/core/contracts/package.json`). Typical subpaths include:

- **`@strapi/contracts`** — barrel; re-exports the main constants and helpers as they are added.
- **`@strapi/contracts/zod`** — canonical **`z`** from the supported Zod entry (aligned with the rest of the monorepo).
- **`@strapi/contracts/reserved-names`** — reserved model/attribute names and predicates.
- **`@strapi/contracts/content-type-grammar`** — `DEFAULT_TYPES`, `modelTypes`, `typeKinds`, UID targets, core/plugin UIDs.

New subpaths should be listed in `package.json` **`exports`** and treated as **public API** (semver).

---

## Patterns

- **Predicates + Zod:** prefer **one** implementation (e.g. `isReservedAttributeName`) and have Zod refinements **call** it—avoid a duplicate `z.enum([...])` that omits wildcard rules.
- **Shims:** packages such as **Content-Type Builder** may re-export from **`@strapi/contracts`** so existing import paths keep working during migration.

---

## Further reading (repository)

In-repo **draft** design notes and migration checklists may live under **`docs/rfcs/`** (e.g. `contracts-package-and-shared-contracts.md`). Those files are part of the Git repository but are **not** required reading for every contributor; this page is the **canonical contributor overview** for **`@strapi/contracts`**.
