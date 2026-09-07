const TINTS = 6;

function tintOf(username: string) {
  let hash = 0;
  for (const ch of username) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % TINTS;
}

function initials(displayName: string, username: string) {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const source = words[0] ?? username;
  return source.slice(0, 2).toUpperCase();
}

type Props = {
  username: string;
  displayName: string;
  size?: 'md' | 'lg';
};

export function Monogram({ username, displayName, size = 'md' }: Props) {
  return (
    <span
      className={size === 'lg' ? 'monogram lg' : 'monogram'}
      style={{ background: `var(--tint-${tintOf(username)})` }}
      aria-hidden="true"
    >
      {initials(displayName, username)}
    </span>
  );
}
