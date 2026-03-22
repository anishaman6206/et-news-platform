import { NextRequest } from "next/server";

const SERVICE_URL = process.env.BRIEFING_URL!;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const topic    = searchParams.get("topic");
  const question = searchParams.get("question");

  const backendUrl = question
    ? `${SERVICE_URL}/briefing/ask`
    : `${SERVICE_URL}/briefing/generate?topic=${encodeURIComponent(topic ?? "")}`;

  try {
    const res = await fetch(backendUrl, {
      method:  question ? "POST" : "GET",
      headers: question ? { "Content-Type": "application/json" } : {},
      body:    question ? JSON.stringify({ topic, question }) : undefined,
    });

    return new Response(res.body, {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      },
    });
  } catch {
    return new Response("data: {\"error\":\"Service unavailable\"}\n\n", {
      status: 503,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  try {
    const res = await fetch(`${SERVICE_URL}/briefing/ask`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    return new Response(res.body, {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      },
    });
  } catch {
    return new Response("data: {\"error\":\"Service unavailable\"}\n\n", {
      status: 503,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
}
