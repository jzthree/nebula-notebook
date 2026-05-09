import { afterEach, describe, expect, it, vi } from 'vitest';
import { NebulaClient } from '../notebook/client.js';

describe('NebulaClient uploadFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends path before file in multipart uploads', async () => {
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000' });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);

      const formData = body as FormData;
      expect(Array.from(formData.keys())).toEqual(['path', 'file']);
      expect(formData.get('path')).toBe('/tmp');

      const filePart = formData.get('file');
      expect(filePart).toBeInstanceOf(File);
      expect((filePart as File).name).toBe('demo.bin');

      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.uploadFile('/tmp', Buffer.from('hello'), 'demo.bin');

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
