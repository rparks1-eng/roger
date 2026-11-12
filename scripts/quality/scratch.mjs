// Use the caller's owned scratch, this Mac's manager, or a portable owned temp.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
export async function qaScratch() {
  const supplied = process.env.CODEX_ARTIFACT_DIR;
  if (supplied) {
    if (!path.isAbsolute(supplied)) throw new Error('CODEX_ARTIFACT_DIR must be absolute.');
    await mkdir(supplied, { recursive: true });
    return { work: supplied, async close() {} };
  }
  const helper = path.join(
    os.homedir(),
    'Atlas',
    'Projects',
    'Tools',
    'Mac Resource Management',
    'Artifact Lifecycle',
    'lifecycle.py',
  );
  if (process.platform === 'darwin' && existsSync(helper)) {
    const run = JSON.parse(
      execFileSync('/usr/bin/python3', [helper, 'begin', '--purpose', 'Reader browser workflow'], {
        encoding: 'utf8',
      }),
    );
    return {
      work: run.work,
      async close() {
        for (let attempt = 0; attempt < 8; attempt++) {
          let receipt;
          try {
            receipt = JSON.parse(
              execFileSync('/usr/bin/python3', [helper, 'finish', run.id], {
                encoding: 'utf8',
                stdio: 'pipe',
                timeout: 20_000,
              }),
            );
            if (receipt.status === 'complete') return;
          } catch (error) {
            receipt = String(error.stdout || error.message).slice(-500);
          }
          if (!existsSync(path.dirname(run.work))) return;
          if (attempt === 7)
            throw new Error(`Managed scratch closure incomplete: ${JSON.stringify(receipt)}`);
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      },
    };
  }
  const work = await mkdtemp(path.join(os.tmpdir(), 'reader-qa-'));
  return {
    work,
    async close() {
      await rm(work, { recursive: true });
    },
  };
}
export const browserOptions = {
  headless: true,
  ...(process.env.READER_BROWSER_CHANNEL === 'chromium'
    ? {}
    : {
        channel:
          process.env.READER_BROWSER_CHANNEL ||
          (process.platform === 'darwin' ? 'chrome' : 'chromium'),
      }),
};
