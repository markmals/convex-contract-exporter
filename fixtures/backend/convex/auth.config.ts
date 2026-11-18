import type { AuthConfig } from "convex/server";

// `FIXTURE_JWKS` is a `data:` URI JWKS that scripts/local-backend.mjs
// generates per deployment and sets before pushing; its `token` command signs
// matching JWTs.
export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "convex-contract-fixture",
      issuer: "https://fixture.convex-contract-exporter.invalid",
      jwks: process.env.FIXTURE_JWKS!,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
