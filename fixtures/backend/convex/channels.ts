import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const trimmed = name.trim();
    if (trimmed === "") {
      throw new ConvexError({
        code: "INVALID_NAME",
        message: "Channel names must not be empty.",
      });
    }
    const existing = await ctx.db
      .query("channels")
      .withIndex("by_name", (q) => q.eq("name", trimmed))
      .unique();
    if (existing !== null) {
      throw new ConvexError({
        code: "DUPLICATE_NAME",
        message: `A channel named "${trimmed}" already exists.`,
      });
    }
    return await ctx.db.insert("channels", {
      name: trimmed,
      topic: null,
      visibility: "public",
      messageCount: 0n,
    });
  },
});

export const get = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => await ctx.db.get("channels", channelId),
});

export const list = query({
  handler: async (ctx) =>
    await ctx.db.query("channels").withIndex("by_name").collect(),
});

export const setTopic = mutation({
  args: { channelId: v.id("channels"), topic: v.union(v.string(), v.null()) },
  handler: async (ctx, { channelId, topic }) => {
    await ctx.db.patch("channels", channelId, { topic });
  },
});

export const archive = internalMutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    await ctx.db.patch("channels", channelId, { archivedAt: Date.now() });
  },
});
