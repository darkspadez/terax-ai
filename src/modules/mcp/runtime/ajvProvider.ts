import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";

/**
 * Stands in for the MCP SDK's AJV validator: `vite.config.ts` resolves the
 * SDK's `validation/ajv-provider.js` here, so AJV is not bundled. AJV
 * compiles each schema into code with `new Function`, which the app's CSP
 * refuses (no `unsafe-eval`), so it could not run anyway; and Oarlock treats a
 * tool's output as untrusted text whatever its shape, so structured output
 * is passed through as the server sent it.
 */
export class AjvJsonSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (input) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    });
  }
}
