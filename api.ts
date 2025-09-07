export async function apiFetch(url: string) {
  const res = await fetch(url, {
    cache: "no-store", // always fetch fresh data
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }

  return res.json();
}
