import { NextRequest } from "next/server";
import { handleChatStart } from "./handler";
import { store } from "@/lib/store";

export async function POST(req: NextRequest) {
  return handleChatStart(req, store());
}
