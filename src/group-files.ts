/**
 * Group workspace read-back — the host side of the dashboard's
 * `onGroupFileRead` hook (GET /api/agent-groups/:id/files?path=).
 *
 * Lets the NanoDash app browse `groups/<folder>/` read-only: '' or a directory
 * path lists entries; a file path returns text content (capped). All policy
 * lives here:
 *   - path safety: resolved target must stay inside the group dir (no '..',
 *     no absolute paths, symlinks resolved before the check)
 *   - noise dirs (node_modules, .git, package stores) are hidden from listings
 *   - only reasonably-sized text files are returned; binaries are refused
 */
import fs from 'fs';
import path from 'path';

import { getAgentGroup } from './db/agent-groups.js';
import { GROUPS_DIR } from './config.js';

const FILE_CAP = 64 * 1024;
/** Hidden from listings — tooling noise, not agent work product. */
const HIDDEN = new Set(['node_modules', '.git', '.pnpm-store', '.DS_Store']);

export interface GroupFileResult {
  ok: boolean;
  kind?: 'dir' | 'file';
  entries?: Array<{ name: string; size: number; mtime: string; dir: boolean }>;
  content?: string | null;
  truncated?: boolean;
  error?: string;
}

/** Heuristic binary sniff: a NUL byte in the first 8KB means "not text". */
function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

export async function readGroupFile(groupId: string, relPath: string): Promise<GroupFileResult> {
  const group = getAgentGroup(groupId);
  if (!group) return { ok: false, error: 'unknown agent group' };

  const root = fs.realpathSync(path.resolve(GROUPS_DIR, group.folder));
  // Normalize + resolve INSIDE the root; reject anything that escapes it
  // (covers '..', absolute paths, and symlinks pointing outside).
  const target = path.resolve(root, relPath);
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return { ok: false, error: 'not found' };
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    return { ok: false, error: 'path escapes the workspace' };
  }

  const stat = fs.statSync(real);
  if (stat.isDirectory()) {
    const entries = fs
      .readdirSync(real, { withFileTypes: true })
      .filter((e) => !HIDDEN.has(e.name))
      .flatMap((e) => {
        // Group dirs contain container-path symlinks (e.g. `.claude-shared.md`
        // → /app/CLAUDE.md) that dangle on the host — skip what can't stat.
        try {
          const s = fs.statSync(path.join(real, e.name));
          return [
            {
              name: e.name,
              size: s.isDirectory() ? 0 : s.size,
              mtime: s.mtime.toISOString(),
              dir: s.isDirectory(),
            },
          ];
        } catch {
          return [];
        }
      })
      // Directories first, then by name.
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { ok: true, kind: 'dir', entries };
  }

  if (stat.size > 2 * 1024 * 1024) {
    return { ok: false, error: 'file too large to view' };
  }
  const buf = fs.readFileSync(real);
  if (looksBinary(buf)) {
    return { ok: false, error: 'binary file — not viewable' };
  }
  const text = buf.toString('utf-8');
  const truncated = text.length > FILE_CAP;
  return {
    ok: true,
    kind: 'file',
    content: truncated ? text.slice(0, FILE_CAP) : text,
    truncated,
  };
}
