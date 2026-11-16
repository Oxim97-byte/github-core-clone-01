// Opaque, stable Relay-style global ids. Encoded as base64url of a typed tag so
// they never equal a plain numeric database id or issue number.

export type GlobalKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User';

export function encodeGlobalId(kind: GlobalKind, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export function repoGlobalId(repoId: number): string {
  return encodeGlobalId('Repository', [repoId]);
}

export function issueGlobalId(repoId: number, number: number): string {
  return encodeGlobalId('Issue', [repoId, number]);
}

export function pullGlobalId(repoId: number, number: number): string {
  return encodeGlobalId('PullRequest', [repoId, number]);
}

export function commentGlobalId(commentId: number): string {
  return encodeGlobalId('IssueComment', [commentId]);
}

export function userGlobalId(userId: number): string {
  return encodeGlobalId('User', [userId]);
}
