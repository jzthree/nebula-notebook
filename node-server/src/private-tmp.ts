/**
 * Per-user private temp directories.
 *
 * Shared paths like /tmp/nebula-kernels break on multi-user machines twice
 * over: the first user's mkdir (with a restrictive umask) locks everyone else
 * out, and anything world-readable leaks — kernel connection files carry the
 * HMAC key, which is remote code execution as the kernel's owner for anyone
 * who can read it.
 *
 * Layout: <tmpdir>/nebula-<username>/<segments...>, mode 0700 throughout.
 * /tmp is sticky, so another user CAN pre-create our directory name — we
 * verify ownership after mkdir and refuse to use a directory we don't own.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function privateTmpDir(...segments: string[]): string {
  const user = (os.userInfo().username || String(process.getuid?.() ?? 'user'))
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const root = path.join(os.tmpdir(), `nebula-${user}`);
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    const st = fs.statSync(root);
    if (st.uid !== process.getuid()) {
      throw new Error(
        `${root} exists but is owned by uid ${st.uid}, not us (${process.getuid()}) — ` +
        `refusing to write private files into another user's directory. Remove or rename it.`
      );
    }
    // mkdirSync's mode is filtered by umask and ignored for pre-existing dirs;
    // assert the closed mode explicitly.
    fs.chmodSync(root, 0o700);
  }
  return dir;
}
