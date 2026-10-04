import { buildOpenApiDocument } from "@/lib/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(buildOpenApiDocument(), { headers: {
    "Content-Type": "application/vnd.oai.openapi+json;version=3.1",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}
