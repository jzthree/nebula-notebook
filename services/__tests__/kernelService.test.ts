/**
 * Tests for kernelService multi-session support
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally
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

      const outputs: any[] = [];
      const executePromise = kernelService.executeCode(
        sessionId,
        'print("hello")',
        (output) => outputs.push(output)
      );

      // Find the WebSocket for this session
      const ws = MockWebSocket.instances.find(w => w.url.includes('exec-session'));
      expect(ws).toBeDefined();

      // Simulate output and result
      ws?.simulateMessage({ type: 'output', output: { type: 'stdout', content: 'hello\n' } });
      ws?.simulateMessage({ type: 'result', result: { status: 'ok' } });

      await executePromise;

      expect(outputs.length).toBe(1);
      expect(outputs[0].content).toBe('hello\n');
    });
  });

  describe('output replay routing', () => {
    it('should route sync_outputs for active cell through the executeCode handler', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'replay-session', kernel_name: 'python3' })
      });
      const sessionId = await kernelService.startKernel('python3');

      // Wait for WebSocket
      await new Promise(resolve => setTimeout(resolve, 10));

      const onOutput = vi.fn();
      const onBuffered = vi.fn();
      const unsubscribe = kernelService.onBufferedOutput((sid, output, cellId) => {
        onBuffered(sid, output, cellId);
      });

      const executePromise = kernelService.executeCode(
        sessionId,
        'print("replay")',
        (output) => onOutput(output),
        'cell-1'
      );

      const ws = MockWebSocket.instances.find(w => w.url.includes('replay-session'));
      expect(ws).toBeDefined();

      ws?.simulateMessage({
        type: 'sync_outputs',
        outputs: [{ seq: 1, cell_id: 'cell-1', output: { type: 'stdout', content: 'replayed\n' } }],
        latest_seq: 1,
      });
      ws?.simulateMessage({ type: 'result', result: { status: 'ok' } });

      await executePromise;
      unsubscribe();

      expect(onOutput).toHaveBeenCalledTimes(1);
      expect(onOutput.mock.calls[0][0].content).toBe('replayed\n');
      expect(onBuffered).not.toHaveBeenCalled();
    });

    it('should route sync_outputs for other cells to buffered output subscribers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session_id: 'replay-other-session', kernel_name: 'python3' })
      });
      const sessionId = await kernelService.startKernel('python3');

      // Wait for WebSocket
      await new Promise(resolve => setTimeout(resolve, 10));

      const onOutput = vi.fn();
      const onBuffered = vi.fn();
      const unsubscribe = kernelService.onBufferedOutput((sid, output, cellId) => {
        onBuffered(sid, output, cellId);
      });

      const executePromise = kernelService.executeCode(
        sessionId,
        'print("replay")',
        (output) => onOutput(output),
        'cell-1'
      );

      const ws = MockWebSocket.instances.find(w => w.url.includes('replay-other-session'));
      expect(ws).toBeDefined();

      ws?.simulateMessage({
        type: 'sync_outputs',
        outputs: [{ seq: 1, cell_id: 'cell-2', output: { type: 'stdout', content: 'buffered\n' } }],
        latest_seq: 1,
      });
      ws?.simulateMessage({ type: 'result', result: { status: 'ok' } });

      await executePromise;
      unsubscribe();

      expect(onOutput).not.toHaveBeenCalled();
      expect(onBuffered).toHaveBeenCalledTimes(1);
      expect(onBuffered.mock.calls[0][1].content).toBe('buffered\n');
      expect(onBuffered.mock.calls[0][2]).toBe('cell-2');
    });
  });
});
