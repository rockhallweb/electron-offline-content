import { describe, expect, it } from "vitest";
import {
  jsonObjectSchema,
  mediaCacheStatusSchema,
  parseWithSchema,
} from "../../src/internal/validation.js";
import { DataValidationError } from "../../src/shared/errors.js";

describe("validation", () => {
  it("reports sibling object issues together", () => {
    expect(() =>
      parseWithSchema(
        mediaCacheStatusSchema,
        {
          phase: "unknown",
          activeGenerationId: -1,
          progress: null,
          lastRun: null,
          error: null,
          updatedAt: "bad",
        },
        "media cache status",
      ),
    ).toThrow(
      new RegExp(
        [
          "phase: Expected one of",
          "activeGenerationId: Expected non-negative integer",
          "updatedAt: Expected non-negative integer",
        ].join(".*"),
        "s",
      ),
    );
  });

  it("reports nested array and record issues together", () => {
    expect(() =>
      parseWithSchema(
        jsonObjectSchema,
        {
          badNumber: Number.NaN,
          nested: [1, undefined, { alsoBad: Number.POSITIVE_INFINITY }],
        },
        "metadata",
      ),
    ).toThrow(
      new RegExp(
        [
          "badNumber: Expected JSON value",
          "nested.1: Expected JSON value",
          "nested.2.alsoBad: Expected JSON value",
        ].join(".*"),
        "s",
      ),
    );
  });

  it("preserves special prototype keys in parsed records", () => {
    const metadata = JSON.parse('{"__proto__":{"polluted":true},"constructor":"kept"}') as unknown;

    const parsed = parseWithSchema(jsonObjectSchema, metadata, "metadata");

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(parsed.constructor).toBe("kept");
  });

  it("still wraps aggregated validation issues in DataValidationError", () => {
    expect(() =>
      parseWithSchema(
        mediaCacheStatusSchema,
        {
          phase: "unknown",
          activeGenerationId: -1,
        },
        "media cache status",
      ),
    ).toThrow(DataValidationError);
  });
});
