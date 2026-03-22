import { NextRequest, NextResponse } from "next/server";

const SERVICE_URL = process.env.FEED_URL!;

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const { searchParams } = new URL(request.url);
  const path = params.path.join("/");
  const qs = searchParams.toString();
  const url = `${SERVICE_URL}/${path}${qs ? `?${qs}` : ""}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const path = params.path.join("/");
  const url = `${SERVICE_URL}/${path}`;
  try {
    const body = await request.json();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}
