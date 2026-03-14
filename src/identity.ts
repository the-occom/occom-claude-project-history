import { execSync } from "child_process";
import { hostname } from "os";
import type { PGlite } from "@electric-sql/pglite";
import type { DeveloperIdentity } from "./types.js";
import { newId } from "./db.js";

function safeExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve developer identity from git config, CI env, or hostname fallback.
 */
export function resolveIdentity(cwd?: string): DeveloperIdentity {
  const dir = cwd ?? process.cwd();

  // 1. Git config
  const email = safeExec("git config user.email", dir);
  const name = safeExec("git config user.name", dir);
  if (email) {
    return { id: email, name: name ?? email };
  }

  // 2. CI environment
  const ciEmail = process.env.GITLAB_USER_EMAIL
    ?? process.env.GITHUB_ACTOR
    ?? process.env.CI_COMMITTER_EMAIL;
  if (ciEmail) {
    return { id: ciEmail, name: ciEmail };
  }

  // 3. Hostname fallback
  const host = hostname();
  return { id: `local@${host}`, name: `local@${host}` };
}

/**
 * Upsert developer row — INSERT ON CONFLICT UPDATE last_seen_at and session_count.
 */
export async function upsertDeveloper(
  identity: DeveloperIdentity,
  db: PGlite
): Promise<void> {
  await db.query(
    `INSERT INTO developers (id, name, first_seen_at, last_seen_at, session_count)
     VALUES ($1, $2, NOW(), NOW(), 1)
     ON CONFLICT (id) DO UPDATE
       SET last_seen_at = NOW(),
           session_count = developers.session_count + 1,
           name = COALESCE(NULLIF($2, ''), developers.name)`,
    [identity.id, identity.name]
  );
}
