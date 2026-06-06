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
import { execFileSync } from 'child_process';
import crypto from 'crypto';

import { getAgentGroup } from './db/agent-groups.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';

/** launchd PATH lacks /opt/homebrew/bin — resolve ffmpeg explicitly. */
const FFMPEG_BIN =
  ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p2) => fs.existsSync(p2)) ?? 'ffmpeg';

const FILE_CAP = 64 * 1024;
/** Media (image/audio) is served base64 up to this cap — voice notes and
 *  screenshots, not videos. */
const MEDIA_CAP = 4 * 1024 * 1024;
/** Hidden from listings — tooling noise, not agent work product. */
const HIDDEN = new Set(['node_modules', '.git', '.pnpm-store', '.DS_Store']);

/** Extensions served as base64 media instead of text. */
const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

export interface GroupFileResult {
  ok: boolean;
  kind?: 'dir' | 'file';
  entries?: Array<{ name: string; size: number; mtime: string; dir: boolean }>;
  content?: string | null;
  /** 'base64' for media files; absent/utf-8 for text. */
  encoding?: 'utf-8' | 'base64';
  /** Set for media files (image/* or audio/*). */
  mime?: string;
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
  return readFromRoot(root, relPath);
}

/** Shared core: path-confined read under an already-realpathed root. */
async function readFromRoot(root: string, relPath: string): Promise<GroupFileResult> {
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

  // Media (images / voice notes) → base64 with a mime so the app can render
  // or play it inline.
  const ext = path.extname(real).toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (mime) {
    if (stat.size > MEDIA_CAP) return { ok: false, error: 'media file too large to view' };
    // OGG/Opus (WhatsApp voice notes) is undecodable on iOS — AVPlayer plays
    // silence. Transcode to AAC/m4a once via ffmpeg (cached by content path)
    // so every client can play it. Fail open to the original bytes when
    // ffmpeg is unavailable.
    if (ext === '.ogg' || ext === '.opus') {
      try {
        const cacheDir = path.join('/tmp', 'nanoclaw-voice-cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const key = crypto.createHash('sha1').update(real).digest('hex');
        const m4a = path.join(cacheDir, `${key}.m4a`);
        if (!fs.existsSync(m4a)) {
          execFileSync(FFMPEG_BIN, ['-y', '-i', real, '-c:a', 'aac', '-b:a', '64k', m4a], {
            stdio: 'pipe',
            timeout: 30_000,
          });
        }
        return {
          ok: true,
          kind: 'file',
          mime: 'audio/mp4',
          encoding: 'base64',
          content: fs.readFileSync(m4a).toString('base64'),
          truncated: false,
        };
      } catch {
        /* fall through to the original ogg bytes */
      }
    }
    return {
      ok: true,
      kind: 'file',
      mime,
      encoding: 'base64',
      content: fs.readFileSync(real).toString('base64'),
      truncated: false,
    };
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

/**
 * Read a file from a SESSION directory — used to serve message attachments
 * (the app's inline image rendering). Restricted to the inbox/ subtree, which
 * is where extractAttachmentFiles lands inbound media. Same path-safety and
 * media/text policy as the group reader.
 */
export async function readSessionFile(
  agentGroupId: string,
  sessionId: string,
  relPath: string,
): Promise<GroupFileResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(agentGroupId) || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return { ok: false, error: 'invalid ids' };
  }
  if (!relPath.startsWith('inbox/')) {
    return { ok: false, error: 'only inbox/ attachments are readable' };
  }
  const dir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId);
  if (!fs.existsSync(dir)) return { ok: false, error: 'unknown session' };
  return readFromRoot(fs.realpathSync(dir), relPath);
}
