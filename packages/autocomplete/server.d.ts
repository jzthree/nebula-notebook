// Type shim for consumers on classic (node10) module resolution, which cannot
// read the "exports" map. Runtime resolution still goes through "exports".
export * from "./dist/server/fastify.js";
