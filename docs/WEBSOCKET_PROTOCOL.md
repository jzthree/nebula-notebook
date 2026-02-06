# Nebula Notebook WebSocket Protocol

This document describes the WebSocket protocol used for code execution between the Nebula Notebook frontend and backend.

## Connection

```
ws(s)://{host}/api/kernels/{session_id}/ws
```

Replace `{session_id}` with the kernel session ID obtained from `/api/kernels/start` or `/api/kernels/for-file`.

## Message Format

All messages are JSON objects with a `type` field that identifies the message type.

---

## Client-to-Server Messages

### Execute Code

Request code execution in the kernel.

```json
{
  "type": "execute",
  "code": "print('Hello, World!')",
  "cell_id": "abc123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Must be `"execute"` |
| code | string | Yes | Python code to execute |
| cell_id | string | No | Notebook cell ID for routing output/status |

---

### Sync Buffered Outputs

Request replay of outputs that may have been missed due to a disconnect.

```json
{
  "type": "sync_outputs",
  "since": 123
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Must be `"sync_outputs"` |
| since | number | Yes | Replay outputs with `seq > since` |

---

### Acknowledge Outputs

Tell the server it may prune buffered outputs up to a sequence number.

```json
{
  "type": "ack_outputs",
  "up_to": 123
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Must be `"ack_outputs"` |
| up_to | number | Yes | Highest received output sequence number |

---

## Server-to-Client Messages

### Status Update

Indicates kernel execution state changes.

```json
{
  "type": "status",
  "status": "busy",
  "cell_id": "abc123"
}
```

| Field | Type | Description |
|-------|------|-------------|
| type | string | Always `"status"` |
| status | string | `"busy"` when executing, `"idle"` when complete |
| cell_id | string | Optional cell ID currently executing |

### Output

Streamed output from code execution.

```json
{
  "type": "output",
  "output": {
    "type": "stdout",
    "content": "Hello, World!\n"
  },
  "seq": 123,
  "cell_id": "abc123"
}
```

| Field | Type | Description |
|-------|------|-------------|
| type | string | Always `"output"` |
| output.type | string | Output type (see below) |
| output.content | string | Output content |
| seq | number | Monotonic per-session output sequence |
| cell_id | string | Optional cell ID this output belongs to |

**Output Types:**

| Type | Description | Content Format |
|------|-------------|----------------|
| `stdout` | Standard output | Plain text |
| `stderr` | Standard error | Plain text |
| `image` | Image (PNG) | Base64-encoded PNG |
| `html` | Rich HTML output | HTML string |
| `error` | Execution error | Error traceback (ANSI stripped) |

### Buffered Output Replay

Response to `sync_outputs`.

```json
{
  "type": "sync_outputs",
  "outputs": [
    {
      "seq": 123,
      "cell_id": "abc123",
      "output": { "type": "stdout", "content": "Hello\n" }
    }
  ],
  "latest_seq": 123
}
```

| Field | Type | Description |
|-------|------|-------------|
| type | string | Always `"sync_outputs"` |
| outputs | array | Buffered outputs since requested `since` |
| latest_seq | number | Latest output sequence known to the server |

### Execution Result

Final result when execution completes.

```json
{
  "type": "result",
  "result": {
    "status": "ok",
    "execution_count": 5
  }
}
```

**Success result:**
| Field | Type | Description |
|-------|------|-------------|
| result.status | string | `"ok"` for successful execution |
| result.execution_count | number | Cell execution number |

**Error result:**
```json
{
  "type": "result",
  "result": {
    "status": "error",
    "error": "Error message"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| result.status | string | `"error"` for failed execution |
| result.error | string | Error description |

### Error

WebSocket-level error (not code execution error).

```json
{
  "type": "error",
  "error": "Session not found"
}
```

---

## Execution Flow

### Successful Execution

```
Client                          Server
   |                               |
   |----execute (code)------------>|
   |                               |
   |<------status: busy------------|
   |                               |
   |<------output: stdout----------|  (0 or more, includes seq)
   |<------output: stderr----------|  (0 or more, includes seq)
   |<------output: image-----------|  (0 or more, includes seq)
   |                               |
   |<------result: ok--------------|
   |<------status: idle------------|
   |                               |
```

### Execution with Error

```
Client                          Server
   |                               |
   |----execute (code)------------>|
   |                               |
   |<------status: busy------------|
   |                               |
   |<------output: error-----------|
   |                               |
   |<------result: ok--------------|
   |<------status: idle------------|
   |                               |
```

Note: Python exceptions during execution are sent as `output: error` messages. The `result` status is still `"ok"` because the kernel itself is fine. The `result.status` is `"error"` only for kernel-level failures.

### Long-Running Execution

The WebSocket has no timeout. Cells can run indefinitely until:
- Execution completes naturally
- Client sends an interrupt via REST API (`POST /api/kernels/{session_id}/interrupt`)
- WebSocket connection is closed

---

## Notes

- The server broadcasts status and outputs to all WebSocket clients connected to the same kernel session.
- `ack_outputs` currently prunes the server-side buffer globally for the session (not per-client).

---

## Output Processing

### Standard Output/Error

```python
# Code:
print("Hello")
import sys
print("Error", file=sys.stderr)
```

```json
{"type": "output", "output": {"type": "stdout", "content": "Hello\n"}, "seq": 1, "cell_id": "abc123"}
{"type": "output", "output": {"type": "stderr", "content": "Error\n"}, "seq": 2, "cell_id": "abc123"}
```

### Display Data (Matplotlib, PIL, etc.)

```python
# Code:
import matplotlib.pyplot as plt
plt.plot([1, 2, 3])
plt.show()
```

```json
{"type": "output", "output": {"type": "image", "content": "<base64-png>"}, "seq": 3, "cell_id": "abc123"}
```

### HTML Output (DataFrames, etc.)

```python
# Code:
import pandas as pd
df = pd.DataFrame({'a': [1, 2], 'b': [3, 4]})
df
```

```json
{"type": "output", "output": {"type": "html", "content": "<table>...</table>"}, "seq": 4, "cell_id": "abc123"}
```

### Execution Errors

```python
# Code:
x = undefined_variable
```

```json
{
  "type": "output",
  "output": {
    "type": "error",
    "content": "NameError: name 'undefined_variable' is not defined\n\n    x = undefined_variable\n        ^^^^^^^^^^^^^^^^^^^"
  },
  "seq": 5,
  "cell_id": "abc123"
}
```

Note: ANSI escape codes are stripped from error tracebacks.

---

## Client Implementation Example

### JavaScript/TypeScript

```typescript
interface ExecuteMessage {
  type: 'execute';
  code: string;
  cell_id?: string;
}

interface StatusMessage {
  type: 'status';
  status: 'busy' | 'idle';
  cell_id?: string;
}

interface OutputMessage {
  type: 'output';
  output: {
    type: 'stdout' | 'stderr' | 'image' | 'html' | 'error';
    content: string;
  };
  seq: number;
  cell_id?: string;
}

interface ResultMessage {
  type: 'result';
  result: {
    status: 'ok' | 'error';
    execution_count?: number;
    error?: string;
  };
}

interface ErrorMessage {
  type: 'error';
  error: string;
}

type ServerMessage = StatusMessage | OutputMessage | ResultMessage | ErrorMessage;

class KernelWebSocket {
  private ws: WebSocket;
  private outputs: OutputMessage['output'][] = [];

  constructor(sessionId: string) {
    this.ws = new WebSocket(`ws://localhost:8000/api/kernels/${sessionId}/ws`);

    this.ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      this.handleMessage(msg);
    };
  }

  execute(code: string): void {
    this.outputs = [];
    this.ws.send(JSON.stringify({ type: 'execute', code }));
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'status':
        console.log('Kernel status:', msg.status);
        break;

      case 'output':
        this.outputs.push(msg.output);
        this.renderOutput(msg.output);
        break;

      case 'result':
        console.log('Execution complete:', msg.result);
        break;

      case 'error':
        console.error('WebSocket error:', msg.error);
        break;
    }
  }

  private renderOutput(output: OutputMessage['output']): void {
    switch (output.type) {
      case 'stdout':
        // Append to stdout display
        break;
      case 'stderr':
        // Append to stderr display (different styling)
        break;
      case 'image':
        // Create <img src="data:image/png;base64,{content}">
        break;
      case 'html':
        // Render HTML in sandbox
        break;
      case 'error':
        // Display error traceback
        break;
    }
  }
}
```

### Python (for testing)

```python
import asyncio
import websockets
import json

async def execute_code(session_id: str, code: str):
    uri = f"ws://localhost:8000/api/kernels/{session_id}/ws"

    async with websockets.connect(uri) as ws:
        # Send execute request
        await ws.send(json.dumps({
            "type": "execute",
            "code": code
        }))

        # Receive messages until idle
        while True:
            msg = json.loads(await ws.recv())

            if msg["type"] == "status":
                print(f"Status: {msg['status']}")
                if msg["status"] == "idle":
                    break

            elif msg["type"] == "output":
                output = msg["output"]
                print(f"[{output['type']}] {output['content']}")

            elif msg["type"] == "result":
                print(f"Result: {msg['result']}")

            elif msg["type"] == "error":
                print(f"Error: {msg['error']}")
                break

# Usage
asyncio.run(execute_code("session-id-here", "print('Hello')"))
```

---

## Connection Lifecycle

### Establishing Connection

1. Obtain session ID via `/api/kernels/start` or `/api/kernels/for-file`
2. Connect to WebSocket: `ws(s)://{host}/api/kernels/{session_id}/ws`
3. Connection is ready immediately after WebSocket `onopen`

### Connection Loss

- Server logs `WebSocket disconnected for session {session_id}`
- Kernel continues running (not terminated)
- Client can reconnect with same session ID
- On reconnect, client should request replay via `sync_outputs` (using its last seen/acked `seq`)

### Graceful Disconnect

Simply close the WebSocket connection. The kernel session remains active and can be:
- Reused by reconnecting
- Stopped via `DELETE /api/kernels/{session_id}`
- Cleaned up automatically on server shutdown

---

## Error Handling

### Session Not Found

If the session ID is invalid or the kernel was stopped:

```json
{
  "type": "error",
  "error": "Session xxx not found"
}
```

### Kernel Crash

If the kernel process crashes during execution:

1. `output: error` message with crash details
2. `result: error` message
3. Session becomes invalid; client should restart kernel

### Network Interruption

- WebSocket automatically closes
- Client should implement reconnection logic
- Use `/api/kernels/{session_id}/status` to check if session is still valid
- Use `/api/kernels/for-file` to get/create kernel for notebook

---

## Best Practices

1. **Handle all message types** - Don't assume message order
2. **Accumulate outputs** - Multiple `output` messages per execution
3. **Check execution_count** - Use for display ([1], [2], etc.)
4. **Implement reconnection** - WebSocket connections can drop
5. **Use interrupt API** - For long-running cells, interrupt via REST API
6. **Sanitize HTML output** - Render HTML in sandboxed iframe
