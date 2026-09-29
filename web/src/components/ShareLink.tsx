import { useRef, useState } from 'react';

/** Полный адрес страницы сайта — с учётом базового пути (витрина живёт в /Social-site/). */
export const siteUrl = (path: string) =>
  new URL(`${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`, window.location.origin).href;

/**
 * Ссылка, которую отдают другим: поле только для чтения и «Скопировать».
 * Буфер обмена бывает недоступен (старый браузер, не https) — тогда текст
 * просто выделяется, и его копируют сами.
 */
export function ShareLink({ path, label }: { path: string; label: string }) {
  const url = siteUrl(path);
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      field.current?.select();
    }
  }

  return (
    <div className="share-link">
      <label className="field">
        <span>{label}</span>
        <input ref={field} type="text" readOnly value={url} onFocus={(e) => e.target.select()} />
      </label>
      <button className="btn ghost small" type="button" onClick={() => void copy()}>
        {copied ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  );
}
