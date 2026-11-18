import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction } from "./_generated/server";
import { echoArgs } from "./values";

export const echo = action({
  args: echoArgs,
  handler: async (_ctx, args) => args,
});

// Actions that call other functions need an explicit return type to break the
// `api`/`internal` type cycle.
export const channelSummary = action({
  args: { channelId: v.id("channels") },
  handler: async (
    ctx,
    { channelId },
  ): Promise<{ channelId: Id<"channels">; messageCount: number }> => {
    const messageCount = await ctx.runQuery(internal.messages.countForChannel, {
      channelId,
    });
    return { channelId, messageCount };
  },
});

export const announce = internalAction({
  args: { channelId: v.id("channels"), body: v.string() },
  handler: async (ctx, { channelId, body }) => {
    await ctx.runMutation(internal.messages.postSystem, {
      channelId,
      body,
      reason: "announcement",
    });
  },
});
