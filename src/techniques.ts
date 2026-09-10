import { z } from "zod";

export const techniqueSchema = z.enum(["bash", "mcp-raw", "mcp-filter", "mcp-filter-readonly"]);
export type Technique = z.infer<typeof techniqueSchema>;

export function techniqueSettings(technique: Technique) {
  return {
    mcpEnabled: technique !== "bash",
    toolsets: technique === "mcp-filter" || technique === "mcp-filter-readonly" ? "repos" : null,
    readOnly: technique === "mcp-filter-readonly",
  };
}

export function mcpHeaders(technique: Technique, token: string): Record<string, string> {
  const settings = techniqueSettings(technique);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (settings.toolsets) headers["X-MCP-Toolsets"] = settings.toolsets;
  if (settings.readOnly) headers["X-MCP-Readonly"] = "true";
  return headers;
}
