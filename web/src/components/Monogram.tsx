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
  avatarUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
};

/** A photo when there is one, the tinted initials when there isn't. */
export function Monogram({ username, displayName, avatarUrl, size = 'md' }: Props) {
  const className = size === 'md' ? 'monogram' : `monogram ${size}`;

  if (avatarUrl) {
    return <img className={className} src={avatarUrl} alt="" aria-hidden="true" loading="lazy" />;
  }

  return (
    <span
      className={className}
      style={{ background: `var(--tint-${tintOf(username)})` }}
      aria-hidden="true"
    >
      {initials(displayName, username)}
    </span>
  );
}
