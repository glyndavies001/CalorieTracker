// @ts-nocheck
// Supabase Edge Function entry point. The logic (and its tests) live in handler.ts.
import { handler } from "./handler.ts";

Deno.serve(handler);
