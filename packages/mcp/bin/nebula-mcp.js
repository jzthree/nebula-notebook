#!/usr/bin/env node
// Single bin, two roles:
//   `npx nebula-notebook-mcp`            → start the MCP server (what agent configs run)
//   `npx nebula-notebook-mcp setup-mcp`  → register the MCP with installed agent CLIs
if (process.argv[2] === 'setup-mcp') {
  process.argv.splice(2, 1); // drop the subcommand so setup sees its own flags
  await import('../setup-mcp.js');
} else {
  await import('../dist/mcp/index.js');
}
