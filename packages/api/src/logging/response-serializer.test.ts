// Every request was logging status 0: `reply.statusCode` is undefined at the
// point Fastify's pino integration calls this serializer, and only
// `reply.raw.statusCode` (the underlying Node response) actually held it.
// Confirmed on production logs — every line, success or denial, read
// `"statusCode":0` — which hid a real error behind what looked like a
// clean 401.

import { describe, it, expect } from "vitest";
import { serializeResponse } from "./index.js";

describe("serializeResponse", () => {
  it("reads the real status from the underlying Node response", () => {
    expect(serializeResponse({ raw: { statusCode: 401 } })).toEqual({ statusCode: 401 });
    expect(serializeResponse({ raw: { statusCode: 200 } })).toEqual({ statusCode: 200 });
  });

  it("falls back to reply.statusCode when raw is absent", () => {
    expect(serializeResponse({ statusCode: 429 })).toEqual({ statusCode: 429 });
  });

  it("defaults to 0 only when neither is set", () => {
    expect(serializeResponse({})).toEqual({ statusCode: 0 });
  });
});
