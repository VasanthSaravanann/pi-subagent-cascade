import { describe, expect, it } from "vitest";

/**
 * The extension entry is not exercised by the pure unit tests, and a syntax
 * slip in it would otherwise only surface inside a live pi session. Vite
 * resolves the .js specifiers to the .ts sources, so importing here is a real
 * parse-and-evaluate check of the tool + command registration module.
 */
describe("extension entry", () => {
	it("imports and exposes a registration function", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.default).toBe("function");
	});
});
