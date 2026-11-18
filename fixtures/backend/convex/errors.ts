import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";

export const check = query({
  args: {
    outcome: v.union(
      v.literal("success"),
      v.literal("applicationError"),
      v.literal("serverError"),
    ),
  },
  handler: async (_ctx, { outcome }) => {
    if (outcome === "applicationError") {
      throw new ConvexError({
        code: "REQUESTED_FAILURE",
        message: "The caller requested an application error.",
      });
    }
    if (outcome === "serverError") {
      throw new Error("The caller requested a server error.");
    }
    return { outcome };
  },
});
