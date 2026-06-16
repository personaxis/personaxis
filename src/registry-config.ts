/**
 * Configuration for the public Personaxis registry that this CLI talks to.
 *
 * The CLI is a public package on npm. The token below is "security through
 * inconvenience" — it filters casual scrapers but anyone who reads the package
 * source can copy it. Treat it as a versioned signal, not a secret. Rotate
 * it on each major CLI release.
 */

export const REGISTRY_BASE_URL =
	process.env.PERSONAXIS_REGISTRY_URL ?? "https://personaxis.com/api/v1/registry";

/**
 * Embedded client token. The server matches this against env
 * PERSONAXIS_CLI_TOKEN. If they diverge (old CLI vs rotated server token),
 * users see a clear "upgrade your CLI" message.
 */
export const REGISTRY_CLIENT_TOKEN = "510BwRhI8A3jayxwNoYcm10a2O-nPA8HUvLBMlee7dY";

export const REGISTRY_UA_PREFIX = "personaxis-cli/";
