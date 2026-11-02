import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();

/*
 * Hash-Routing (z. B. .../SplitApp/#/groups/1), damit die App auf GitHub Pages ohne Server-Rewrites läuft.
 */
export function navigate(to: string, replace = false) {
  const url = `${location.pathname}${location.search}#${to}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

/** Aktuelle Route aus dem Hash, z. B. "/groups/1?expense=3". */
export function currentRoute(): string {
  const route = location.hash.replace(/^#/, '');
  return route.startsWith('/') ? route : '/';
}

/** Absolute URL zu einer Route (für Einladungslinks). */
export function absoluteUrl(route: string): string {
  return `${location.origin}${location.pathname}#${route}`;
}

export function useLocation() {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    listeners.add(update);
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);
  const [path, search = ''] = currentRoute().split('?');
  return { path: path!, query: new URLSearchParams(search) };
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={`#${href}`}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    />
  );
}

/** Einfaches Pfad-Matching: "/groups/:id" */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}
