import * as cjsModule from "./index.cjs";

const mod = cjsModule?.default ?? cjsModule;

if (!mod || typeof mod.handler !== "function") {
  throw new Error("beaver-api handler export missing");
}

export const handler = mod.handler;
