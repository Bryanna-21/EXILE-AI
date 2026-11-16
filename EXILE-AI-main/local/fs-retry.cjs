/**
 * rename that tolerates the transient locks Windows produces.
 *
 * On Windows, renaming over an existing file can fail with EPERM/EBUSY/EACCES while an antivirus scanner,
 * search indexer or backup agent briefly holds the destination open. The failure is transient, so retry
 * a few times with a short back-off before giving up. On other platforms the first error is thrown as-is.
 * Synchronous on purpose: callers are synchronous atomic-write helpers.
 */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameSyncRetry(fs, from, to, { platform = process.platform, retries = 6, baseDelayMs = 15, sleep = sleepSync } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const transient = platform === "win32" && TRANSIENT.has(error && error.code);
      if (!transient || attempt >= retries) throw error;
      sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

module.exports = { renameSyncRetry };
