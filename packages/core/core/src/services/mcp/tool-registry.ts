// eslint-disable-next-line import/extensions
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core, Modules } from '@strapi/types';
import { z } from '@strapi/utils';
import { McpCapabilityDefinitionRegistry } from './internal/McpCapabilityDefinitionRegistry';
import {
  type McpCapabilityRegistry,
  McpCapabilityRegistryBase,
} from './internal/McpCapabilityRegistry';
import { createSafeCapabilityRegistration } from './utils/createSafeCapabilityRegistration';
import type { McpAdminTokenAbility } from './authentication';

export function makeMcpToolDefinition<
  Name extends string,
  Title extends string,
  Description extends string,
  OutputSchema extends z.ZodObject<z.ZodRawShape>,
  InputSchema extends z.ZodObject<z.ZodRawShape>,
  Access extends Modules.MCP.McpCapabilityAccess,
>(
  tool: {
    name: Name;
    title: Title;
    description: Description;
    inputSchema: InputSchema;
    outputSchema: OutputSchema;
    createHandler: (
      strapi: Core.Strapi,
      context: Modules.MCP.McpHandlerContext
    ) => Modules.MCP.McpToolCallback<InputSchema, OutputSchema>;
  } & Access
): Modules.MCP.McpToolDefinition<Name, InputSchema, OutputSchema, Title, Description> & Access;
export function makeMcpToolDefinition<
  Name extends string,
  Title extends string,
  Description extends string,
  OutputSchema extends z.ZodObject<z.ZodRawShape>,
  Access extends Modules.MCP.McpCapabilityAccess,
>(
  tool: {
    name: Name;
    title: Title;
    description: Description;
    inputSchema?: undefined;
    outputSchema: OutputSchema;
    createHandler: (
      strapi: Core.Strapi,
      context: Modules.MCP.McpHandlerContext
    ) => Modules.MCP.McpToolCallback<undefined, OutputSchema>;
  } & Access
): Modules.MCP.McpToolDefinition<Name, undefined, OutputSchema, Title, Description> & Access;
export function makeMcpToolDefinition(tool: Modules.MCP.McpToolDefinition) {
  return tool;
}

export class McpToolRegistry
  extends McpCapabilityRegistryBase<'tool', Modules.MCP.McpToolDefinition, RegisteredTool>
  implements McpCapabilityRegistry
{
  #strapi: Core.Strapi;

  #ability: McpAdminTokenAbility;

  constructor(ctx: {
    strapi: Core.Strapi;
    definitions: McpCapabilityDefinitionRegistry<'tool', Modules.MCP.McpToolDefinition>;
    ability: McpAdminTokenAbility;
  }) {
    super(ctx.definitions);
    this.#strapi = ctx.strapi;
    this.#ability = ctx.ability;
  }

  bind(mcpServer: McpServer) {
    super.register((definition) => {
      const { name, title, description, inputSchema, outputSchema, createHandler } = definition;

      // Bind the session ability into the handler context so handlers can enforce
      // field-level and entity-level permission checks without touching the global MCP session.
      const context: Modules.MCP.McpHandlerContext = { userAbility: this.#ability };
      const createHandlerWithContext = (strapi: Core.Strapi) => createHandler(strapi, context);

      return createSafeCapabilityRegistration({
        strapi: this.#strapi,
        capabilityType: 'Tool',
        name,
        createHandler: createHandlerWithContext,
        createFallbackHandler(errorMessage) {
          return async () => ({
            content: [
              {
                type: 'text' as const,
                text: `Tool "${name}" failed to initialize: ${errorMessage}`,
              },
            ],
            structuredContent: {},
            isError: true,
          });
        },
        createErrorResult(error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Tool "${name}" execution failed: ${error.message}`,
              },
            ],
            structuredContent: {},
            isError: true,
          };
        },
        registerWithSdk(safeHandler) {
          return mcpServer.registerTool(
            name,
            { title, description, inputSchema, outputSchema },
            // @ts-expect-error - Internal handler type mismatch due to optional inputSchema
            safeHandler
          );
        },
      });
    });
  }
}
