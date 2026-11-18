import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  channels: defineTable({
    name: v.string(),
    // Required but nullable: always present on the wire, possibly `null`.
    topic: v.union(v.string(), v.null()),
    // Optional: absent from the document when unset.
    description: v.optional(v.string()),
    visibility: v.union(v.literal("public"), v.literal("private")),
    messageCount: v.int64(),
    // Optional and nullable are independent.
    archivedAt: v.optional(v.union(v.float64(), v.null())),
  }).index("by_name", ["name"]),

  messages: defineTable({
    channelId: v.id("channels"),
    // Discriminated by `kind`.
    author: v.union(
      v.object({
        kind: v.literal("user"),
        tokenIdentifier: v.string(),
        name: v.union(v.string(), v.null()),
      }),
      v.object({ kind: v.literal("anonymous") }),
      v.object({ kind: v.literal("system"), reason: v.string() }),
    ),
    body: v.string(),
    attachment: v.optional(v.id("_storage")),
    editedAt: v.union(v.float64(), v.null()),
    committedAt: v.commitTs(),
  }).index("by_channel", ["channelId", "committedAt"]),
});
