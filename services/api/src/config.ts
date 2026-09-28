/**
 * Server configuration.
 *
 * Everything secret lives here and only here, read from the environment. §19:
 * the desktop client is untrusted and must never hold the Discord webhook, the
 * database credentials, or the identity salt. Nothing in this file is ever
 * serialised into a response.
 */

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  /** HMAC key for identity hashing. Secret, and rotating it re-anonymises. */
  readonly identitySalt: string;
  /** Server-side only. Absent means reporting is inert. Never leaves this process. */
  readonly discordWebhook: string | undefined;
  readonly discordEnabled: boolean;
  /** What to do with a finding that may name an undiscovered thing. */
  readonly discordSpoilerPolicy: 'suppress' | 'redact';
  readonly discordPostResolutions: boolean;
  readonly discordIncludeCommander: boolean;
  /** Forum tag ids, by category name. Ids are per-channel, so they are config. */
  readonly discordTagsRaw: string | undefined;
  /**
   * Guards the administrative endpoints, which can post to a live Discord
   * channel. Absent means those endpoints do not exist at all -- a deployment
   * that forgot to set it exposes nothing rather than exposing an open one.
   */
  readonly adminToken: string | undefined;
  readonly rateLimitPerMinute: number;
  /**
   * Which peers may be believed about `X-Forwarded-For`.
   *
   * Passed to Fastify verbatim, so it accepts anything proxy-addr does: an
   * address, a CIDR, a comma-separated list, or the keyword `loopback`.
   */
  readonly trustProxy: string;
  readonly env: 'development' | 'production' | 'test';
}

export class ConfigError extends Error {}

/**
 * A weak salt is worse than none, because it looks like protection.
 *
 * Commander FIDs are short and structured, so an unsalted or guessable hash is
 * reversible by anyone holding the database: enumerate the space, compare. The
 * salt is what makes `fid_hash` a distinguisher rather than a reversible
 * identifier, which is the whole basis for claiming in PRIVACY.md that FIDs are
 * not stored.
 */
const MIN_SALT_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.NODE_ENV ?? 'development') as Config['env'];

  const databaseUrl = env.EDFM_DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigError('EDFM_DATABASE_URL is required.');
  }

  const identitySalt = env.EDFM_IDENTITY_SALT;
  if (!identitySalt) {
    throw new ConfigError(
      'EDFM_IDENTITY_SALT is required. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (identitySalt.length < MIN_SALT_LENGTH) {
    throw new ConfigError(
      `EDFM_IDENTITY_SALT must be at least ${MIN_SALT_LENGTH} characters. ` +
        'A guessable salt does not anonymise anything -- commander FIDs are ' +
        'short enough to enumerate against a known key.',
    );
  }

  const webhook = env.EDFM_DISCORD_WEBHOOK;
  if (webhook && !webhook.startsWith('https://')) {
    throw new ConfigError('EDFM_DISCORD_WEBHOOK must be an https URL.');
  }
  if (webhook && !/\/api\/webhooks\/\d+\//.test(webhook)) {
    // Caught at boot rather than as a 404 on the first real report.
    throw new ConfigError(
      'EDFM_DISCORD_WEBHOOK does not look like a Discord webhook URL ' +
        '(expected .../api/webhooks/<id>/<token>).',
    );
  }

  const spoilerPolicy = env.EDFM_DISCORD_SPOILER_POLICY ?? 'suppress';
  if (spoilerPolicy !== 'suppress' && spoilerPolicy !== 'redact') {
    throw new ConfigError(
      "EDFM_DISCORD_SPOILER_POLICY must be 'suppress' or 'redact'.",
    );
  }

  return {
    port: Number(env.EDFM_PORT ?? 8787),
    host: env.EDFM_HOST ?? '127.0.0.1',
    databaseUrl,
    identitySalt,
    discordWebhook: webhook,
    // Off unless switched on AND given a webhook, so a half-configured
    // deployment posts nothing rather than posting somewhere unintended.
    discordEnabled: env.EDFM_DISCORD_ENABLED === 'true' && webhook !== undefined,
    // A Forum post is public, permanent and searchable -- weaker containment
    // than the admin channel redaction was designed for. Default to not
    // posting spoiler-sensitive findings at all.
    discordSpoilerPolicy: spoilerPolicy,
    discordPostResolutions: env.EDFM_DISCORD_POST_RESOLUTIONS !== 'false',
    // Off by default: a name in a public moderation thread is a different
    // decision from being credited on a contribution list (§20).
    discordIncludeCommander: env.EDFM_DISCORD_INCLUDE_COMMANDER === 'true',
    discordTagsRaw: env.EDFM_DISCORD_FORUM_TAGS,
    adminToken: env.EDFM_ADMIN_TOKEN,
    rateLimitPerMinute: Number(env.EDFM_RATE_LIMIT_PER_MINUTE ?? 60),
    /*
     * Loopback only, because that is the documented topology: nginx terminates
     * TLS and proxies to 127.0.0.1.
     *
     * This was `true`, which believes X-Forwarded-For from anyone. Since the
     * service is internet-reachable through nginx, a remote client could name
     * its own address -- and `req.ip` feeds both the rate limiter's key and the
     * stored sourceHash, so the two controls that exist to notice one source
     * flooding the endpoint were both steerable by that source.
     *
     * Overridable for a deployment that puts a different proxy in front, but the
     * default must be the narrow one: getting this wrong fails open and silently.
     */
    trustProxy: env.EDFM_TRUST_PROXY ?? 'loopback',
    env: mode,
  };
}
