/**
 * Operator CLI for /api/v1 API keys (create / list / revoke).
 *
 * Until a key-management UI ships, this is how an operator provisions keys. It
 * talks to whatever Supabase the environment points at (SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY), so for a production key run it with the production
 * env. The raw key is shown ONCE on creation and never stored in plaintext —
 * only its SHA-256 hash and non-secret prefix are persisted.
 *
 *   npx ts-node src/scripts/api-key.ts create --user <uuid> \
 *     --scopes jobs:read,jobs:write --label "Vanward prod" [--rate 60] [--quota 500] [--env live]
 *   npx ts-node src/scripts/api-key.ts list [--user <uuid>]
 *   npx ts-node src/scripts/api-key.ts revoke --id <key-uuid>
 */

import { getSupabaseServiceClient } from "../services/database/client";
import { generateApiKey, API_SCOPES, type ApiScope } from "../services/api/v1/keys";

interface Args {
  _: string[];
  [flag: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      (args._ as string[]).push(a);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function str(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function create(args: Args): Promise<void> {
  const userId = str(args.user);
  const label = str(args.label);
  const scopesRaw = str(args.scopes);
  if (!userId) fail("--user <uuid> is required.");
  if (!label) fail("--label <name> is required.");
  if (!scopesRaw) fail(`--scopes is required (comma-separated from: ${API_SCOPES.join(", ")}).`);

  const scopes = scopesRaw!.split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = scopes.filter((s) => !(API_SCOPES as string[]).includes(s));
  if (invalid.length) fail(`Unknown scope(s): ${invalid.join(", ")}. Valid: ${API_SCOPES.join(", ")}.`);

  const env = (str(args.env) as "live" | "test") || "live";
  if (env !== "live" && env !== "test") fail("--env must be 'live' or 'test'.");
  const rate = args.rate !== undefined ? Number(str(args.rate)) : 60;
  if (!Number.isFinite(rate) || rate <= 0) fail("--rate must be a positive number.");
  const quota = args.quota !== undefined ? Number(str(args.quota)) : null;
  if (quota !== null && (!Number.isFinite(quota) || quota < 0)) fail("--quota must be a non-negative number.");

  const { key, prefix, hash } = generateApiKey(env);
  const supabase = getSupabaseServiceClient();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      user_id: userId!,
      name: label!,
      key_prefix: prefix,
      key_hash: hash,
      scopes: scopes as ApiScope[],
      rate_limit_per_min: rate,
      monthly_quota: quota,
      status: "active",
    })
    .select("id, key_prefix, scopes, rate_limit_per_min, monthly_quota")
    .single();
  if (error || !data) fail(`Could not create key: ${error?.message ?? "unknown error"}`);

  console.log("");
  console.log("API key created. COPY IT NOW — it is shown only once and cannot be recovered:");
  console.log("");
  console.log(`    ${key}`);
  console.log("");
  console.log(`  id:        ${data!.id}`);
  console.log(`  prefix:    ${data!.key_prefix}`);
  console.log(`  scopes:    ${(data!.scopes ?? []).join(", ")}`);
  console.log(`  rate/min:  ${data!.rate_limit_per_min}`);
  console.log(`  quota/mo:  ${data!.monthly_quota ?? "unlimited"}`);
  console.log("");
}

async function list(args: Args): Promise<void> {
  const userId = str(args.user);
  const supabase = getSupabaseServiceClient();
  let query = supabase
    .from("api_keys")
    .select("id, name, key_prefix, scopes, rate_limit_per_min, monthly_quota, status, created_at, last_used_at")
    .order("created_at", { ascending: false });
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) fail(`Could not list keys: ${error.message}`);

  if (!data || data.length === 0) {
    console.log("No API keys found.");
    return;
  }
  // Never print key_hash — only the non-secret prefix.
  for (const k of data) {
    console.log(
      [
        k.status === "active" ? "●" : "○",
        k.key_prefix.padEnd(18),
        (k.status ?? "").padEnd(8),
        (k.name ?? "").padEnd(24),
        `[${(k.scopes ?? []).join(",")}]`.padEnd(24),
        `rate=${k.rate_limit_per_min}`,
        `quota=${k.monthly_quota ?? "∞"}`,
        `last_used=${k.last_used_at ?? "never"}`,
        `id=${k.id}`,
      ].join("  "),
    );
  }
}

async function revoke(args: Args): Promise<void> {
  const id = str(args.id);
  if (!id) fail("--id <key-uuid> is required.");
  const supabase = getSupabaseServiceClient();
  const { data, error } = await supabase
    .from("api_keys")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", id!)
    .select("id, key_prefix, status")
    .single();
  if (error || !data) fail(`Could not revoke key: ${error?.message ?? "no key with that id"}`);
  console.log(`Revoked key ${data!.key_prefix} (${data!.id}). It can no longer authenticate.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (command) {
    case "create":
      await create(args);
      break;
    case "list":
      await list(args);
      break;
    case "revoke":
      await revoke(args);
      break;
    default:
      console.log("Usage: api-key.ts <create|list|revoke> [flags]");
      console.log("  create --user <uuid> --scopes jobs:read,jobs:write --label <name> [--rate 60] [--quota 500] [--env live]");
      console.log("  list [--user <uuid>]");
      console.log("  revoke --id <key-uuid>");
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
