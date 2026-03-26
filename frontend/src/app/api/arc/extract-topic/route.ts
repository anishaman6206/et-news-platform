import { NextRequest, NextResponse } from "next/server";

const SERVICE_URL = process.env.ARC_URL!;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const res = await fetch(`${SERVICE_URL}/extract-topic`, {
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
