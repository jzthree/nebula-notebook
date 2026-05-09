/**
 * Minimal type declarations for 'ws' package
 * Used when @types/ws is not available
 */

declare module 'ws' {
  export default class WebSocket {
    constructor(url: string);
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onerror: ((error: any) => void) | null;
    onmessage: ((event: { data: string | Buffer }) => void) | null;
    send(data: string): void;
    close(): void;
  }
}
