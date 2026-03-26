import { NextRequest } from "next/server";

const SERVICE_URL = process.env.BRIEFING_URL!;

/**
 * The Python backend yields:
 *   data: {\n    "summary": "..."\n    ...\n}\n\n
 *   data: [DONE]\n\n
 *
 * Only the first line of each event block has the `data:` prefix; subsequent
 * JSON lines have no prefix and are silently ignored by EventSource.
 *
 * Fix: read the raw response text, split on the double-newline event boundary,
 * then for each block strip the leading `data: `, treat ALL remaining lines as
 * the value (the backend puts the whole JSON there, just indented), compact it
 * to a single line, and re-emit a proper single-line SSE event.
 */
async function normalisedSSE(backendRes: Response): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        // Read the entire backend response — the briefing service sends
        // one JSON event then [DONE], so buffering is fine and safe.
        const raw = await backendRes.text();

        // Split into event blocks separated by one or more blank lines.
        const blocks = raw.split(/\n\n+/);

        for (const block of blocks) {
          if (!block.trim()) continue;

          // Collect every `data:` line in this block, then also grab any
          // continuation lines that lack the prefix (the backend's bug).
          const lines = block.split("\n");
          const dataLines: string[] = [];
          let inData = false;

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              dataLines.push(line.slice(6));
              inData = true;
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5));
              inData = true;
            } else if (inData && line !== "") {
              // Continuation line — part of the same value (backend bug)
              dataLines.push(line);
            }
          }

          if (dataLines.length === 0) continue;

          // Rejoin the value that was split across lines
          const value = dataLines.join("\n").trim();

          // Compact JSON to one line; pass [DONE] and error strings through
          let emitValue: string;
          if (value === "[DONE]") {
            emitValue = "[DONE]";
          } else {
            try {
              emitValue = JSON.stringify(JSON.parse(value));
            } catch {
              // Not JSON — emit as-is (single line)
              emitValue = value.replace(/\n/g, " ");
            }
          }

          controller.enqueue(encoder.encode(`data: ${emitValue}\n\n`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "stream error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });
}

async function proxySSE(backendUrl: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(backendUrl, init);
    const stream = await normalisedSSE(res);
    return new Response(stream, {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      },
    });
  } catch {
    return new Response(
      `data: ${JSON.stringify({ error: "Service unavailable" })}\n\n`,
      { status: 503, headers: { "Content-Type": "text/event-stream" } }
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const topic    = searchParams.get("topic");
  const question = searchParams.get("question");

  const backendUrl = question
    ? `${SERVICE_URL}/briefing/ask`
    : `${SERVICE_URL}/briefing/generate?topic=${encodeURIComponent(topic ?? "")}`;

  return proxySSE(backendUrl, {
    method:  question ? "POST" : "GET",
    headers: question ? { "Content-Type": "application/json" } : {},
    body:    question ? JSON.stringify({ topic, question }) : undefined,
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json() as { topic?: string; question?: string; context?: string };
  const enrichedQuestion = body.context
    ? `Given this article: "${body.context}"\n\nQuestion: ${body.question ?? ""}`
    : body.question ?? "";

  // Pass the stream straight through — do NOT buffer with normalisedSSE.
  // The Q&A backend now streams token-by-token so every byte must be
  // forwarded as it arrives. Buffering causes apparent truncation.
  try {
    const res = await fetch(`${SERVICE_URL}/briefing/ask`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ topic: body.topic, question: enrichedQuestion }),
    });
    return new Response(res.body, {
      headers: {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection":        "keep-alive",
      },
    });
  } catch {
    return new Response(
      `data: ${JSON.stringify({ error: "Service unavailable" })}\n\n`,
      { status: 503, headers: { "Content-Type": "text/event-stream" } }
    );
  }
}
