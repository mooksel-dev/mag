// A repository's GitHub remote, shared by the clients that call gh.

/** owner/name of a GitHub remote URL; null for another host. */
export function githubRepo(url: string): { owner: string; name: string } | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? { owner: m[1], name: m[2] } : null
}
