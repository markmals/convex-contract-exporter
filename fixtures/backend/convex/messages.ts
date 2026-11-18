import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";

async function adjustMessageCount(
  ctx: MutationCtx,
  channelId: Id<"channels">,
  delta: bigint,
) {
  const channel = await ctx.db.get("channels", channelId);
  if (channel !== null) {
    await ctx.db.patch("channels", channelId, {
      messageCount: channel.messageCount + delta,
    });
  }
}

export const list = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) =>
    await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channelId))
      .collect(),
});

export const paginate = query({
  args: {
    channelId: v.id("channels"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { channelId, paginationOpts }) =>
    await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channelId))
      .order("desc")
      .paginate(paginationOpts),
});

export const get = query({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => await ctx.db.get("messages", messageId),
});

export const send = mutation({
  args: { channelId: v.id("channels"), body: v.string() },
  handler: async (ctx, { channelId, body }) => {
    const channel = await ctx.db.get("channels", channelId);
    if (channel === null) {
      throw new ConvexError({
        code: "CHANNEL_NOT_FOUND",
        message: "The channel does not exist.",
      });
    }
    if (body.trim() === "") {
      throw new ConvexError({
        code: "EMPTY_BODY",
        message: "Message bodies must not be empty.",
      });
    }
    const identity = await ctx.auth.getUserIdentity();
    const messageId = await ctx.db.insert("messages", {
      channelId,
      author:
        identity === null
          ? { kind: "anonymous" }
          : {
              kind: "user",
              tokenIdentifier: identity.tokenIdentifier,
              name: identity.name ?? null,
            },
      body,
      editedAt: null,
      committedAt: ctx.db.vars.commitTs,
    });
    await adjustMessageCount(ctx, channelId, 1n);
    return messageId;
  },
});

export const edit = mutation({
  args: { messageId: v.id("messages"), body: v.string() },
  handler: async (ctx, { messageId, body }) => {
    await ctx.db.patch("messages", messageId, { body, editedAt: Date.now() });
  },
});

export const attach = mutation({
  args: { messageId: v.id("messages"), storageId: v.id("_storage") },
  handler: async (ctx, { messageId, storageId }) => {
    await ctx.db.patch("messages", messageId, { attachment: storageId });
  },
});

export const remove = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get("messages", messageId);
    if (message === null) {
      return;
    }
    await ctx.db.delete("messages", messageId);
    await adjustMessageCount(ctx, message.channelId, -1n);
  },
});

export const countForChannel = internalQuery({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channelId))
      .collect();
    return messages.length;
  },
});

export const postSystem = internalMutation({
  args: { channelId: v.id("channels"), body: v.string(), reason: v.string() },
  handler: async (ctx, { channelId, body, reason }) => {
    const messageId = await ctx.db.insert("messages", {
      channelId,
      author: { kind: "system", reason },
      body,
      editedAt: null,
      committedAt: ctx.db.vars.commitTs,
    });
    await adjustMessageCount(ctx, channelId, 1n);
    return messageId;
  },
});
