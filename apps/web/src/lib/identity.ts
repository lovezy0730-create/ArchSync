const KEY = 'archsync-identity';

export interface Identity {
  name: string;
}

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Identity;
    return typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: Identity): void {
  localStorage.setItem(KEY, JSON.stringify(identity));
}
