/**
 * Tests for kernelService multi-session support
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// Mock fetch globally
const originalFetch = global.fetch;
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  readyState: number = 1; // OPEN

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    // Simulate async connection
    setTimeout(() => this.onopen?.(), 0);
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  });

  // Helper to simulate receiving a message
  simulateMessage(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

// @ts-ignore
const originalWebSocket = global.WebSocket;
global.WebSocket = MockWebSocket;

// Import after mocks are set up
import { kernelService } from '../kernelService';

describe('KernelService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    // Clear service state between tests
    (kernelService as any)._clearAllSessions();
  });

  afterEach(() => {
    // Clean up any open sessions
    MockWebSocket.instances.forEach(ws => ws.close());
  });

  afterAll(() => {
    // Restore globals so other test files in the same Vitest worker are not affected.
    global.fetch = originalFetch;
    // @ts-ignore
    global.WebSocket = originalWebSocket;
  });

  describe('startKernel', () => {
    it('should start a kernel and return session ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'test-session-1', kernel_name: 'python3' })
      });

      const sessionId = await kernelService.startKernel('python3');

      expect(sessionId).toBe('test-session-1');
      expect(mockFetch).toHaveBeenCalledWith('/api/kernels/start', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('python3')
      }));
    });

    it('should include cwd in request when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'test-session-2', kernel_name: 'python3' })
      });

      await kernelService.startKernel('python3', '/home/user/project');

      expect(mockFetch).toHaveBeenCalledWith('/api/kernels/start', expect.objectContaining({
        body: expect.stringContaining('/home/user/project')
      }));
    });

    it('should create WebSocket connection with session ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'ws-test-session', kernel_name: 'python3' })
      });

      await kernelService.startKernel('python3');

      // Wait for WebSocket connection
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      expect(ws.url).toContain('ws-test-session');
    });
  });

  describe('multi-session support', () => {
    it('should support multiple concurrent sessions', async () => {
      // Start first kernel
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'session-a', kernel_name: 'python3' })
      });
      const sessionA = await kernelService.startKernel('python3', '/project-a');

      // Start second kernel
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'session-b', kernel_name: 'python3' })
      });
      const sessionB = await kernelService.startKernel('python3', '/project-b');

      expect(sessionA).toBe('session-a');
      expect(sessionB).toBe('session-b');
      expect(sessionA).not.toBe(sessionB);

      // Both should be connected
      expect(kernelService.isConnected(sessionA)).toBe(true);
      expect(kernelService.isConnected(sessionB)).toBe(true);
    });

    it('should stop specific session without affecting others', async () => {
      // Start two kernels
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'session-1', kernel_name: 'python3' })
      });
      const session1 = await kernelService.startKernel('python3');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'session-2', kernel_name: 'python3' })
      });
      const session2 = await kernelService.startKernel('python3');

      // Stop first session
      mockFetch.mockResolvedValueOnce({ ok: true });
      await kernelService.stopKernel(session1);

      // First should be disconnected, second should still be connected
      expect(kernelService.isConnected(session1)).toBe(false);
      expect(kernelService.isConnected(session2)).toBe(true);
    });
  });

  describe('executeCode', () => {
    it('should execute code in specific session', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'exec-session', kernel_name: 'python3' })
      });
      const sessionId = await kernelService.startKernel('python3');

      // Wait for WebSocket
      await new Promise(resolve => setTimeout(resolve, 10));

      // Complete initial sync handshake so executeCode won't block.
      const ws = MockWebSocket.instances.find(w => w.url.includes('exec-session'));
      expect(ws).toBeDefined();
      ws?.simulateMessage({ type: 'sync_outputs', cells: {} });

      const outputs: any[] = [];
      const executePromise = kernelService.executeCode(
        sessionId,
        'print("hello")',
        (output) => outputs.push(output)
      );

      // Allow the async executeCode() call to enqueue its handler before we simulate messages.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Simulate output and result
      ws?.simulateMessage({ type: 'output', output: { type: 'stdout', content: 'hello\n' }, cell_id: null });
      ws?.simulateMessage({ type: 'result', result: { status: 'ok' } });

      await executePromise;

      expect(outputs.length).toBe(1);
      expect(outputs[0].content).toBe('hello\n');
    });
  });

  describe('sync replace protocol', () => {
    it('should fire onSyncReplace callbacks with cell-indexed outputs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'sync-replace-session', kernel_name: 'python3' })
      });
      await kernelService.startKernel('python3');

      // Wait for WebSocket
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = MockWebSocket.instances.find(w => w.url.includes('sync-replace-session'));
      expect(ws).toBeDefined();

      const onSyncReplace = vi.fn();
      const unsubscribe = kernelService.onSyncReplace(onSyncReplace);

      // Simulate sync_outputs with cell-indexed format
      ws?.simulateMessage({
        type: 'sync_outputs',
        cells: {
          'cell-1': [
            { type: 'stdout', content: 'hello\n' },
            { type: 'stdout', content: 'world\n' },
          ],
          'cell-2': [
            { type: 'stderr', content: 'warning\n' },
          ],
        },
      });

      unsubscribe();

      expect(onSyncReplace).toHaveBeenCalledTimes(1);
      const [sessionId, cellOutputs] = onSyncReplace.mock.calls[0];
      expect(sessionId).toBe('sync-replace-session');
      expect(cellOutputs).toBeInstanceOf(Map);
      expect(cellOutputs.size).toBe(2);

      const cell1Outputs = cellOutputs.get('cell-1');
      expect(cell1Outputs).toHaveLength(2);
      expect(cell1Outputs[0].content).toBe('hello\n');
      expect(cell1Outputs[1].content).toBe('world\n');

      const cell2Outputs = cellOutputs.get('cell-2');
      expect(cell2Outputs).toHaveLength(1);
      expect(cell2Outputs[0].content).toBe('warning\n');
    });

    it('should replace outputs entirely on reconnect (no dedup needed)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'replace-session', kernel_name: 'python3' })
      });
      await kernelService.startKernel('python3');

      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = MockWebSocket.instances.find(w => w.url.includes('replace-session'));
      expect(ws).toBeDefined();

      const onSyncReplace = vi.fn();
      const unsubscribe = kernelService.onSyncReplace(onSyncReplace);

      // First sync
      ws?.simulateMessage({
        type: 'sync_outputs',
        cells: {
          'cell-1': [{ type: 'stdout', content: 'first\n' }],
        },
      });

      // Second sync (simulates reconnect) - should replace, not merge
      ws?.simulateMessage({
        type: 'sync_outputs',
        cells: {
          'cell-1': [
            { type: 'stdout', content: 'first\n' },
            { type: 'stdout', content: 'second\n' },
          ],
        },
      });

      unsubscribe();

      // Both syncs should fire callbacks - the client replaces outputs each time
      expect(onSyncReplace).toHaveBeenCalledTimes(2);

      // Second call should have the complete output array
      const [, cellOutputs] = onSyncReplace.mock.calls[1];
      const cell1Outputs = cellOutputs.get('cell-1');
      expect(cell1Outputs).toHaveLength(2);
      expect(cell1Outputs[0].content).toBe('first\n');
      expect(cell1Outputs[1].content).toBe('second\n');
    });

    it('should route live outputs to buffered callbacks without seq', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'live-output-session', kernel_name: 'python3' })
      });
      await kernelService.startKernel('python3');

      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = MockWebSocket.instances.find(w => w.url.includes('live-output-session'));
      expect(ws).toBeDefined();

      // Complete initial sync
      ws?.simulateMessage({ type: 'sync_outputs', cells: {} });

      const onBuffered = vi.fn();
      const unsubscribe = kernelService.onBufferedOutput(onBuffered);

      // Simulate live output (no seq field)
      ws?.simulateMessage({
        type: 'output',
        output: { type: 'stdout', content: 'hello\n' },
        cell_id: 'cell-B',
      });

      unsubscribe();

      expect(onBuffered).toHaveBeenCalledTimes(1);
      expect(onBuffered.mock.calls[0][1].content).toBe('hello\n');
      // Output should have a UUID id (not kseq:*)
      expect(onBuffered.mock.calls[0][1].id).toBeDefined();
      expect(onBuffered.mock.calls[0][1].id).not.toMatch(/^kseq:/);
    });
  });
});
