/**
 * License system root of trust.
 *
 * These values are compiled into the main process bundle and shipped inside
 * the asar. They are intentionally NOT read from env vars or app-config.json,
 * because allowing either would let a user redirect the app at their own
 * license server signed with their own keypair, replacing the root of trust.
 *
 * To rotate: change these constants and ship a new build.
 */
export const LICENSE_SERVER_URL = 'https://colab91-license-server.tanuj-44c.workers.dev';
export const LICENSE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAExmIdot5+EJbAilti/UwIuBnNOKhognNVVedcxqfIj4=';
