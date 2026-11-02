export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Schlichte, eigenständige Seite für Anmeldung und Zustimmung (läuft auf der Worker-Domain). */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · SplitApp</title>
<style>
  :root { --bg:#f4f6f5; --card:#fff; --text:#17201b; --muted:#5d6b63; --accent:#1f9d6b; --accent-ink:#fff; --border:#dde3df; --danger:#c2412d; --warn:#fff4e0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1412; --card:#18201c; --text:#e8eeea; --muted:#9aa8a0; --accent:#35c58d; --accent-ink:#06120c; --border:#2a3530; --warn:#3a2e14; } }
  * { box-sizing:border-box } body { margin:0; font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:420px; margin:48px auto; padding:0 16px; }
  .brand { font-weight:700; font-size:20px; margin-bottom:16px; display:flex; gap:8px; align-items:center; }
  .brand span { background:var(--accent); color:var(--accent-ink); border-radius:8px; padding:0 8px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:24px; }
  h1 { font-size:20px; margin:0 0 8px } p { color:var(--muted); margin:8px 0 }
  label { display:block; font-size:14px; margin:12px 0 4px; } input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:transparent; color:inherit; font:inherit; }
  button { font:inherit; border-radius:10px; padding:10px 16px; border:1px solid var(--border); background:transparent; color:inherit; cursor:pointer; }
  button.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); font-weight:600; }
  .row { display:flex; gap:8px; margin-top:20px; } .row button { flex:1 }
  ul { padding-left:20px; color:var(--muted) } .error { color:var(--danger); } .small { font-size:13px }
  .warn { background:var(--warn); border-radius:10px; padding:10px 12px; font-size:14px; }
  .linkbtn { border:0; padding:0; color:var(--accent); text-decoration:underline; background:none; font-size:13px; }
  details summary { cursor:pointer; color:var(--accent); font-size:14px; margin-top:16px; }
</style></head><body><main><div class="brand"><span>÷</span> SplitApp</div><div class="card">${body}</div></main></body></html>`;
}

export function htmlResponse(html: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Frame-Options', 'DENY');
  h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'");
  return new Response(html, { status, headers: h });
}
