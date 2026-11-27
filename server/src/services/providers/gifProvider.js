export const ALLOWED_GIF_HOSTS = [
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
  'media.tenor.com',
];

export function isAllowedGifUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && ALLOWED_GIF_HOSTS.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function createMockGifProvider() {
  return {
    name: 'mock-gif',
    async search(query, { limit = 3 } = {}) {
      const safeQ = encodeURIComponent(String(query || 'fun').slice(0, 40));
      return Array.from({ length: Math.min(limit, 3) }, (_, idx) => ({
        id: `mock-${safeQ}-${idx + 1}`,
        title: `${query || 'fun'} #${idx + 1}`,
        url: `https://media.giphy.com/media/mock-${safeQ}-${idx + 1}/giphy.gif`,
        previewUrl: `https://media.giphy.com/media/mock-${safeQ}-${idx + 1}/200w.gif`,
        rating: 'pg',
      }));
    },
  };
}

export function createGiphyProvider({ apiKey = process.env.GIPHY_API_KEY } = {}) {
  if (!apiKey || process.env.NODE_ENV === 'test') {
    return createMockGifProvider();
  }

  return {
    name: 'giphy',
    async search(query, { limit = 3, rating = 'pg' } = {}) {
      const url = new URL('https://api.giphy.com/v1/gifs/search');
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('q', String(query || '').slice(0, 80));
      url.searchParams.set('limit', String(Math.min(limit, 5)));
      url.searchParams.set('rating', rating === 'g' ? 'g' : 'pg');

      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        throw new Error(`GIF provider error (${res.status})`);
      }
      const data = await res.json();
      return (data.data || [])
        .map((item) => ({
          id: String(item.id),
          title: String(item.title || query || 'GIF').slice(0, 80),
          url: item.images?.fixed_height?.url || item.images?.original?.url || '',
          previewUrl: item.images?.fixed_height_small?.url || item.images?.fixed_height?.url || '',
          rating: String(item.rating || 'pg'),
        }))
        .filter((g) => isAllowedGifUrl(g.url) && isAllowedGifUrl(g.previewUrl))
        .slice(0, limit);
    },
  };
}

export const defaultGifProvider = createGiphyProvider();
