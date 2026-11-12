// What of the caller's environment the bundled Node must not get. A command line run with a foreign project's
// environment (ADR-0010: the one command a person lets an agent run, also outside its sandbox) must not have its Node
// told what to load or whom to trust. Node reads these before the first line of our code runs, so the entries remove
// them before they start Node: launcher/macos/busy-emulator and the macOS launcher the app writes
// (packages/app/src/install-files.mjs) with `env -u`, launcher/windows/busy-emulator.cs from the child's environment.
// A test checks that all three hold this same list. Every other program the command line starts on the bundled Node
// (EMU-206, EMU-217) takes its environment from nodeEnvironment().
export const NODE_ENVIRONMENT_DENYLIST = Object.freeze([
  // Node itself.
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_SYSTEM_CA",
  "NODE_USE_ENV_PROXY",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_REPL_HISTORY",
  "NODE_ICU_DATA",
  "NODE_V8_COVERAGE",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_PENDING_DEPRECATION",
  "NODE_REDIRECT_WARNINGS",
  "NODE_COMPILE_CACHE",
  "NODE_TEST_CONTEXT",
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",
  "NODE_UNIQUE_ID",
  "NODE_SKIP_PLATFORM_CHECK",
  // OpenSSL inside Node: a configuration file can load an engine, a module or other certificates.
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** The environment for a program on the bundled Node: the caller's, without what would change how Node starts. */
export function nodeEnvironment(env, platform = process.platform) {
  const denied = new Set(NODE_ENVIRONMENT_DENYLIST.map((name) => (platform === "win32" ? name.toUpperCase() : name)));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !denied.has(platform === "win32" ? name.toUpperCase() : name)));
}
