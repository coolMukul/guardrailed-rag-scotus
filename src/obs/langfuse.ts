import { Langfuse } from 'langfuse';

let langfuse: Langfuse | null = null;

function getClient(): Langfuse | null {
  if (langfuse === undefined) return null;
  if (langfuse === null) {
    try {
      const baseUrl = process.env.LANGFUSE_BASE_URL || 'http://localhost:13000';
      const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
      const secretKey = process.env.LANGFUSE_SECRET_KEY;

      if (!publicKey || !secretKey) {
        console.warn('Langfuse keys not set, observability disabled');
        langfuse = undefined as any;
        return null;
      }

      langfuse = new Langfuse({
        baseUrl,
        publicKey,
        secretKey,
      });
    } catch (err) {
      console.warn('Failed to init Langfuse:', err);
      langfuse = undefined as any;
      return null;
    }
  }
  return langfuse;
}

export interface TraceMetadata {
  [key: string]: string | number | boolean | null | undefined;
}

export async function trace<T>(
  name: string,
  fn: (trace: any) => Promise<T>,
  metadata?: TraceMetadata,
): Promise<T> {
  const client = getClient();
  if (!client) {
    return fn(null);
  }

  const t = client.trace({
    name,
    metadata,
  });

  // Traces have no end() in the SDK — they complete when flushed; only spans end.
  return fn(t);
}

export async function span<T>(
  trace: any,
  name: string,
  fn: () => Promise<T>,
  metadata?: TraceMetadata,
): Promise<T> {
  if (!trace) {
    return fn();
  }

  const s = trace.span({
    name,
    metadata,
  });

  try {
    const result = await fn();
    s.end();
    return result;
  } catch (err) {
    s.end();
    throw err;
  }
}

export async function flush(): Promise<void> {
  const client = getClient();
  if (client) {
    await client.flush();
  }
}
