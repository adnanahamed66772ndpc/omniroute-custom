import { NextRequest, NextResponse } from "next/server";
import {
  getProactiveCompressionRatio,
  setProactiveCompressionRatio,
} from "@/lib/db/compression";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { proactiveCompressionConfigSchema } from "@/shared/validation/compressionConfigSchemas";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

// Read/update the proactive-compression threshold ratio (compression/proactiveConfig DB key)
// that open-sse/handlers/chatCore.ts reads via getProactiveCompressionRatio() to decide when
// reactive context compaction triggers (estimatedTokens > (contextLimit - reserved) * ratio).
// This was DB-backed and hot-reloadable but had no settings route — an operator could not tune
// it without a raw SQLite write. Kept as a dedicated sub-route (sibling of settings/compression
// and settings/compression/mcp-accessibility) so the strict main settings schema stays focused.

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const thresholdRatio = getProactiveCompressionRatio();
    return NextResponse.json({ thresholdRatio });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = validateBody(proactiveCompressionConfigSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    if (validation.data.thresholdRatio !== undefined) {
      await setProactiveCompressionRatio(validation.data.thresholdRatio);
    }

    const thresholdRatio = getProactiveCompressionRatio();
    return NextResponse.json({ thresholdRatio });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
