// Fail fast with a clear message when the runtime is outside the supported Node
// range, BEFORE the native better-sqlite3 binding tries (and fails) to load with
// a cryptic "NODE_MODULE_VERSION" ABI error. Imported first by core/db.ts so it
// runs ahead of the better-sqlite3 import.
//
// The upper bound was 25 until 2026-08-16 and is now 24, so the range matches
// what CI actually tests. Two different failures sit above it, and the message
// below names the nearer one rather than the older one:
//
//   Node 24: better-sqlite3 loads and works, but its Statement destructor runs
//     after the Node environment is torn down and Node 24 asserts on it
//     (RemoteEnvironmentCleanupHook, "Assertion failed: (env) != nullptr").
//     It aborts the process on teardown, which took out two of 48 test files on
//     every CI run. It reproduces on the GitHub runner and not on every box, so
//     "it works here" is not evidence that it works.
//   Node 25+: no prebuilt better-sqlite3 binary at all.
//
// Re-raise the bound when better-sqlite3 ships a Node 24 teardown fix. The
// matrix comment in .github/workflows/ci.yml carries the same note.
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 22 || major >= 24) {
  process.stderr.write(
    `\nenscribe needs Node >=22 <24. You are on Node ${process.versions.node}.\n` +
      `Above that range better-sqlite3 crashes the process on teardown (Node 24) or\n` +
      `has no prebuilt binary at all (Node 25+).\n` +
      `Switch (e.g. \`fnm use 22\` or \`nvm use 22\`), reinstall with \`npm ci\`, then retry.\n\n`,
  );
  process.exit(1);
}
