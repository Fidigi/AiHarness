import type { McpExposure, McpServerInventoryEntry } from '@ai-harness/core';

/** Render the current server-owned Test result, not a second browser pattern engine. */
export function mcpToolExposureValue(
  server: Pick<McpServerInventoryEntry, 'exposure' | 'toolExposure' | 'testStatus'>,
  name: string,
): McpExposure {
  if (server.toolExposure && Object.hasOwn(server.toolExposure, name)) {
    return server.toolExposure[name] ?? server.exposure;
  }
  return server.testStatus?.tools.find(tool => tool.name === name)?.exposure ?? server.exposure;
}
