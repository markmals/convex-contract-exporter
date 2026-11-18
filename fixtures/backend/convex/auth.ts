import { query } from "./_generated/server";

// `UserIdentity` carries an open index signature for custom claims, so the
// result projects a fixed subset.
export const whoami = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    return {
      subject: identity.subject,
      issuer: identity.issuer,
      tokenIdentifier: identity.tokenIdentifier,
      name: identity.name ?? null,
      email: identity.email ?? null,
    };
  },
});
