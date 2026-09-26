import { describe, it, expect } from "vitest";
import { validateLogoImage } from "./logo-image.js";

/** A minimal PNG header: magic + IHDR with the given dimensions (enough for the checks). */
function png(width: number, height: number, extra = 0): string {
  const bytes = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

describe("validateLogoImage", () => {
  it("accepts a PNG within bounds and digests the stored bytes", () => {
    const result = validateLogoImage(png(800, 240));
    expect(result).toMatchObject({ width: 800, height: 240 });
    expect(result?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses JPEG, SVG, oversized dimensions, oversized files and junk", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(40).fill(0)]).toString("base64");
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>").toString("base64");
    expect(validateLogoImage(jpeg)).toBeNull();
    expect(validateLogoImage(svg)).toBeNull();
    expect(validateLogoImage(png(1025, 100))).toBeNull();
    expect(validateLogoImage(png(0, 100))).toBeNull();
    expect(validateLogoImage(png(100, 100, 512 * 1024))).toBeNull();
    expect(validateLogoImage("not base64!")).toBeNull();
    expect(validateLogoImage("")).toBeNull();
  });
});
