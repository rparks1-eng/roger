// Single-owner local preview only. Never read personal Atlas configuration at
// runtime; this app receives only an explicitly provisioned Canvas credential.
import { lstat, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
export const OWNER_CANVAS_FILE = path.join(
  homedir(),
  'Library',
  'Application Support',
  'Atlas Reader Class',
  'canvas-owner.json',
);
function validate(value) {
  if (
    !value ||
    value.version !== 1 ||
    value.origin !== 'https://babson.instructure.com' ||
    typeof value.token !== 'string' ||
    value.token.length < 10 ||
    value.token.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(value.token) ||
    !value.profile ||
    !/^[1-9]\d{0,15}$/.test(String(value.profile.id)) ||
    typeof value.profile.name !== 'string' ||
    value.profile.name.length > 500
  )
    throw new Error('owner-canvas-invalid');
  return {
    token: value.token,
    profile: { id: String(value.profile.id), name: value.profile.name },
  };
}
export async function loadOwnerCanvas(file = OWNER_CANVAS_FILE) {
  try {
    const parent = await lstat(path.dirname(file));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid() ||
      parent.mode & 0o077
    )
      throw new Error('owner-canvas-permissions');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 8192)
        throw new Error('owner-canvas-permissions');
      return validate(JSON.parse(await handle.readFile('utf8')));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // eslint-disable-next-line preserve-caught-error -- The private file/parser cause can contain credential material.
    throw new Error('Owner Canvas configuration could not be opened safely.');
  }
}
export async function saveOwnerCanvas(token, profile, file = OWNER_CANVAS_FILE) {
  const value = { version: 1, origin: 'https://babson.instructure.com', token, profile };
  validate(value);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const parent = await lstat(path.dirname(file));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    parent.mode & 0o077
  )
    throw new Error('owner-canvas-permissions');
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
