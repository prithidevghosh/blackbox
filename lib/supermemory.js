// Minimal Supermemory Local client — raw fetch against the endpoints verified
// in docs/api-notes.md (DECISIONS.md D2 explains why not the SDK).

function headers(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`; // optional: localhost auto-auths
  return h;
}

export async function alive(cfg, timeoutMs = 2500) {
  try {
    const res = await fetch(cfg.baseURL + '/', { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function ingestDocument(cfg, doc, timeoutMs = 30_000) {
  const res = await fetch(`${cfg.baseURL}/v3/documents`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(doc),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json(); // { id, status: "queued" }
}

// /v3/search — document search with chunk scores (v4/search is empty on Local 0.0.5)
export async function search(cfg, q, { limit = 5, containerTags } = {}, timeoutMs = 30_000) {
  const body = { q, limit };
  if (containerTags?.length) body.containerTags = containerTags;
  const res = await fetch(`${cfg.baseURL}/v3/search`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json(); // { results: [...], timing, total }
}

export async function listDocuments(cfg, { containerTags, limit = 100, page = 1 } = {}, timeoutMs = 30_000) {
  const body = { limit, page };
  if (containerTags?.length) body.containerTags = containerTags;
  const res = await fetch(`${cfg.baseURL}/v3/documents/list`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json(); // { memories: [...], pagination }
}

export async function getDocument(cfg, id, timeoutMs = 15_000) {
  const res = await fetch(`${cfg.baseURL}/v3/documents/${id}`, {
    headers: headers(cfg),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`get failed: HTTP ${res.status}`);
  return res.json();
}
