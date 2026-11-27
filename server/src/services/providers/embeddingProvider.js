import crypto from 'node:crypto';

const MOCK_DIMS = 64;

function normalize(vec) {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const mag = Math.sqrt(sumSq) || 1;
  return vec.map((v) => v / mag);
}

/**
 * Deterministic local embedding mock for tests and offline dev.
 * Hashes normalized word tokens + character trigrams into a 64-dim unit vector
 * so semantically overlapping queries rank highest without external network calls.
 */
export function createMockEmbeddingProvider() {
  return {
    name: 'mock-embedding',
    async embed(text) {
      const vec = new Array(MOCK_DIMS).fill(0);
      const words = String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2);

      for (const word of words) {
        const digest = crypto.createHash('sha256').update(word).digest();
        const bucket = digest[0] % MOCK_DIMS;
        vec[bucket] += 2.0;
        for (let i = 0; i <= word.length - 3; i += 1) {
          const tri = word.slice(i, i + 3);
          const triDigest = crypto.createHash('sha256').update(tri).digest();
          vec[triDigest[0] % MOCK_DIMS] += 0.5;
        }
      }
      return normalize(vec);
    },
  };
}

export function createOpenAiEmbeddingProvider({ apiKey = process.env.OPENAI_API_KEY } = {}) {
  if (!apiKey || process.env.NODE_ENV === 'test') {
    return createMockEmbeddingProvider();
  }

  return {
    name: 'openai',
    async embed(text) {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: String(text || '').slice(0, 2000),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        throw new Error(`Embedding provider error (${res.status})`);
      }
      const data = await res.json();
      return data?.data?.[0]?.embedding || [];
    },
  };
}

export const defaultEmbeddingProvider = createOpenAiEmbeddingProvider();
