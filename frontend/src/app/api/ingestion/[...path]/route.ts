import { NextRequest, NextResponse } from "next/server";

const SERVICE_URL = process.env.INGESTION_URL ?? "http://localhost:8006";

async function handler(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const path = params.path.join("/");
  const qs = new URL(request.url).searchParams.toString();
  const url = `${SERVICE_URL}/${path}${qs ? `?${qs}` : ""}`;
  try {
    const init: RequestInit = { method: request.method };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.headers = { "Content-Type": "application/json" };
      init.body = await request.text();
    }
    const res = await fetch(url, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}

export const GET  = handler;
export const POST = handler;
export const PUT  = handler;
