# Nebula Notebook MCP Server

The Nebula MCP server allows Claude Code to interact with Jupyter-style notebooks programmatically through the Model Context Protocol.

## Quick Start

### 1. Make sure Nebula Notebook backend is running

```bash
# Start the Nebula backend server (default: http://localhost:8000)
cd /path/to/nebula-notebook
npm run server
```

### 2. Automated setup (Recommended)

Run the interactive setup script to configure all detected clients:

```bash
npm run setup-mcp
```

**Supported tools** (auto-detected):
- Claude Code
- Claude Desktop
- Cursor IDE
- Gemini CLI
- Codex CLI
- VS Code / GitHub Copilot (workspace via `.vscode/mcp.json`)
- Antigravity (global config if present)

The setup script is idempotent and will skip configs that already contain the correct `nebula-notebook` entry.

### 3. Manual setup (Claude Code example)

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "nebula-notebook": {
      "command": "node",
      "args": ["/path/to/nebula-notebook/packages/mcp/bin/nebula-mcp.js"]
    }
  }
}
```

**Important Configuration Notes:**
- ✅ This config only registers the MCP server binary
- ✅ The MCP server starts disconnected; you must call `connect_server(base_url=...)` in each MCP session

### 4. Restart your AI client

After editing the config:
```bash
# In Claude Code terminal
/exit
# Then restart your client
```

## Agent Workflow (IMPORTANT)

When working with Nebula notebooks, agents should follow this workflow pattern:

### Session Setup (once per conversation)
```
# Always call connect_server first.
connect_server(base_url="http://localhost:4000")  // Example: Nebula UI at :4000
```

### Each Response Pattern
```
start_agent_session(path="/path/to/notebook.ipynb")
  ↓
[perform all notebook operations]
  - read_notebook, read_cell, read_output
  - insert_cell, update_cell, delete_cell
  - execute_cell
  - etc.
  ↓
end_agent_session(path="/path/to/notebook.ipynb")
```

### Why This Pattern?
- **Locking**: `start_agent_session` locks the notebook, preventing user edits during agent work
- **UI Feedback**: Users see a badge showing which agent is working and what it's doing
- **Clean Handoff**: `end_agent_session` unlocks the notebook so users can edit again
- **Per-Response**: Start/end in EVERY response ensures the lock isn't held between turns
- **Path validation**: `start_agent_session` fails if the notebook path doesn't exist (typos are caught early)
- **Fallback**: If you skip `start_agent_session`, the MCP client will auto-start a session on the first write. You’ll see a warning in the tool response encouraging explicit start/end.

### Example: Multi-step Analysis
```
Response 1:
  start_agent_session → insert_cell (imports) → execute_cell → end_agent_session

Response 2:
  start_agent_session → insert_cell (analysis) → execute_cell → read_output → end_agent_session

Response 3:
  start_agent_session → insert_cell (visualization) → execute_cell → end_agent_session
```

## Switching Between Nebula Instances

You can switch between different Nebula instances using the `connect_server` tool. This is useful for:
- Switching from local development to remote server (via SSH tunnel)
- Testing notebooks on different Nebula installations
- Moving between development and production environments

### How it works

1. **No default connection**: On startup, the MCP server is disconnected
2. **Connect explicitly**: Use `connect_server(base_url=...)` to choose the server
3. **All operations use current connection**: Every tool uses the currently connected server

### Example: Switching between instances

```typescript
// Connect to local server explicitly
connect_server(base_url="http://localhost:3000")
start_agent_session(path="/local/notebook.ipynb")
insert_cell(path="/local/notebook.ipynb", ...)

// Switch to remote server via SSH tunnel
connect_server(base_url="http://localhost:8001")

// Now all operations go to the new server
start_agent_session(path="/remote/notebook.ipynb")
insert_cell(path="/remote/notebook.ipynb", ...)
execute_cell(path="/remote/notebook.ipynb", ...)

// Switch back to local server
connect_server(base_url="http://localhost:3000")

// Back to local server
insert_cell(path="/local/notebook.ipynb", ...)
```

### Connection management

- One active connection at a time
- `connect_server` switches the current connection
- All tools automatically use the current connection
- Simple and predictable - no per-notebook URL tracking

### Agent sessions and locking

Write operations require an agent session. The MCP server automatically creates a session (using a stable MCP-scoped ID) the first time it performs a write on a notebook, so you don't have to call it manually. You can still call `start_agent_session`/`end_agent_session` explicitly if you want tighter control over lock lifetimes.

## Available MCP Tools

Once connected, Claude Code can use these tools:

### Connection Management
- `connect_server` - Connect to a Nebula server (switches current connection)

### Notebook Operations
- `read_notebook` - Read all cells from a notebook
- `read_cell` - Read a specific cell by index or ID
- `read_output` - Read cell execution outputs
- `insert_cell` - Insert a new cell
- `update_cell` - Update cell content or type
- `delete_cell` - Delete a cell
- `clear_notebook` - Clear all cells from a notebook
- `move_cell` - Move a cell to a different position
- `duplicate_cell` - Duplicate a cell
- `search_cells` - Search for cells by content
- `update_metadata` - Update cell metadata
- `start_agent_session` - Start an agent session (locks notebook)
- `end_agent_session` - End an agent session (unlocks notebook)

### Kernel Operations
- `list_kernels` - List available kernel specs
- `kernel_start` - Start a new kernel session
- `kernel_stop` - Stop a kernel session
- `kernel_restart` - Restart a kernel
- `kernel_interrupt` - Interrupt a running kernel

### Execution
- `execute_cell` - Execute a cell and get results

## Usage Examples

### Example 1: Create a notebook and run analysis

```
User: "Create a notebook at /tmp/analysis.ipynb with a cell that imports pandas and numpy"

Claude uses:
1. clear_notebook(path="/tmp/analysis.ipynb")
2. insert_cell(path="/tmp/analysis.ipynb", content="import pandas as pd\nimport numpy as np", cell_type="code")
3. execute_cell(path="/tmp/analysis.ipynb", cell_index=0)
4. read_output(path="/tmp/analysis.ipynb", cell_index=0)
```

### Example 2: Read and analyze existing notebook

```
User: "What's in my notebook at /tmp/data.ipynb?"

Claude uses:
1. read_notebook(path="/tmp/data.ipynb", format="brief")
2. read_cell(path="/tmp/data.ipynb", cell_index=0)
```

### Example 3: Interactive multi-step workflow

```
User: "Analyze stock data for AAPL - fetch it, plot it, and calculate moving averages"

Claude uses:
1. clear_notebook(path="/tmp/stock-analysis.ipynb")
2. kernel_start(file_path="/tmp/stock-analysis.ipynb")
3. insert_cell(...) - Add import cell
4. execute_cell(...) - Run imports
5. insert_cell(...) - Add data fetch cell
6. execute_cell(...) - Fetch data
7. read_output(...) - Check if data loaded
8. insert_cell(...) - Add plotting cell
9. execute_cell(...) - Generate plot
... and so on
```

## Tool Usage in Claude Code

Claude Code will automatically use tools with the prefix:

```
mcp__nebula-notebook__TOOL_NAME
```

For example:
- `mcp__nebula-notebook__read_notebook`
- `mcp__nebula-notebook__execute_cell`
- `mcp__nebula-notebook__insert_cell`

## Troubleshooting

### MCP server not connecting

Check:
1. Is Nebula running? Try `curl http://localhost:3000/api/health` (frontend dev proxy) or `curl http://localhost:8000/api/health` (backend)
2. Did you call `connect_server(base_url=...)` before using other tools?
3. Did you restart Claude Code after config changes?
4. Check MCP server logs in Claude Code (usually visible in stderr)

### "No such tool available" error

- The MCP server may not be configured or running
- Check that the server name matches: `nebula-notebook`
- Restart Claude Code after config changes

### "Request failed: fetch failed" error

- The MCP server can't reach the Nebula backend
- Verify you're calling `connect_server(base_url=...)` with the correct server URL
- Check if the backend is actually running
- For SSH tunnels, ensure port forwarding is active

### Tools work but responses are slow

- Increase timeout if using remote/forwarded connections
- Check network latency to the backend
- Consider running backend locally instead of over SSH

## Publishing the MCP Server

See [MCP_DISTRIBUTION.md](./MCP_DISTRIBUTION.md) for instructions on publishing to npm and Smithery.

## Development

### Testing locally

```bash
# Build the MCP server
npm run build

# Test manually via stdio
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node bin/nebula-mcp.js

# Test tool listing (specify custom URL if needed)
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node bin/nebula-mcp.js
```

### Adding new tools

1. Add tool definition to `src/tools/notebook.ts`, `kernel.ts`, or `execution.ts`
2. Export from the appropriate tools array
3. Rebuild: `npm run build`
4. Restart Claude Code to pick up new tools

## Architecture

```
Claude Code
    ↓ (JSON-RPC over stdio)
nebula-mcp.js (MCP Server)
    ↓ (HTTP/WebSocket)
Nebula Backend (FastAPI)
    ↓
Jupyter Kernels
```

The MCP server is a thin wrapper that:
1. Implements Model Context Protocol (JSON-RPC 2.0 over stdio)
2. Translates tool calls to Nebula API requests
3. Formats responses for Claude Code display
4. Handles WebSocket connections for streaming execution

## License

MIT
