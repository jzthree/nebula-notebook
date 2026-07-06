#!/usr/bin/env node
// Agent-facing CLI for Nebula Notebook — thin shim over the compiled CLI.
// Run `nebula --help` for the command list; requires NEBULA_URL or --url.
await import('../dist/cli/index.js');
