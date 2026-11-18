import { v } from "convex/values";
import { query } from "./_generated/server";

// Shared by `values:echo` and `actions:echo`; a non-function export that must
// not appear in the public API.
export const echoArgs = {
  string: v.string(),
  float: v.float64(),
  int: v.int64(),
  boolean: v.boolean(),
  bytes: v.bytes(),
  nothing: v.null(),
  array: v.array(v.float64()),
  // Validator field names must be identifiers; these collide with keywords.
  object: v.object({
    class: v.string(),
    default: v.int64(),
    snake_case: v.boolean(),
  }),
  record: v.record(v.string(), v.float64()),
  union: v.union(v.string(), v.int64()),
  literal: v.union(v.literal("alpha"), v.literal("beta")),
  shape: v.union(
    v.object({ type: v.literal("circle"), radius: v.float64() }),
    v.object({
      type: v.literal("rectangle"),
      width: v.float64(),
      height: v.float64(),
    }),
  ),
  nullable: v.union(v.string(), v.null()),
  optional: v.optional(v.string()),
  optionalNullable: v.optional(v.union(v.float64(), v.null())),
};

export const echo = query({
  args: echoArgs,
  handler: async (_ctx, args) => args,
});

// Values that exercise the wire encoding without requiring client input.
export const special = query({
  handler: async () => {
    const pair: [string, number] = ["left", 1];
    return {
      nan: NaN,
      positiveInfinity: Infinity,
      negativeInfinity: -Infinity,
      negativeZero: -0,
      int64Min: -(2n ** 63n),
      int64Max: 2n ** 63n - 1n,
      bytes: new Uint8Array([0, 1, 254, 255]).buffer,
      pair,
      // Values, unlike validators, allow any non-control ASCII field name.
      keys: { "kebab-case": "dash", "with space": "space", "dot.ted": "dot" },
      tag: "special" as const,
      version: 1n as const,
    };
  },
});
