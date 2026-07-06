/**
 * Ambient augmentation for the 'ws' module.
 *
 * Why this exists: packages/mcp/src/ws.d.ts contains a minimal
 * `declare module 'ws'` (default export only). Because the root tsconfig has
 * no include/exclude, that ambient declaration is part of the root program and
 * shadows the real @types/ws (installed under node-server/node_modules) for
 * every file in the repo. That broke `import { WebSocket, WebSocketServer }
 * from 'ws'` in node-server sources/tests under `tsc --noEmit`, even though
 * those imports are correct per @types/ws and work at runtime.
 *
 * Ambient declarations for the same module merge, so this file re-exports the
 * real @types/ws class/server as the named exports the code actually uses.
 * It is type-only: no runtime effect, and it does not alter packages/mcp's
 * own build (whose tsconfig only includes packages/mcp/src).
 */
declare module 'ws' {
  import WSReal = require('../node-server/node_modules/@types/ws/index');
  export { WSReal as WebSocket };
  export import WebSocketServer = WSReal.Server;
}
