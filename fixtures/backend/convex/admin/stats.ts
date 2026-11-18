import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";

export default query({
  handler: async (ctx) => {
    const channels = await ctx.db.query("channels").collect();
    const messages = await ctx.db.query("messages").collect();
    return { channelCount: channels.length, messageCount: messages.length };
  },
});

export const messageCounts = query({
  handler: async (ctx) => {
    const counts: Record<Id<"channels">, bigint> = {};
    for (const channel of await ctx.db.query("channels").collect()) {
      counts[channel._id] = channel.messageCount;
    }
    return counts;
  },
});
