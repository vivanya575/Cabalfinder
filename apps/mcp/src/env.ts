import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: new URL("../../../.env", import.meta.url).pathname });

const envSchema = z.object({
  HELIUS_API_KEY: z.string().default(""),
  HELIUS_NETWORK: z.string().default("mainnet-beta")
});

export const env = envSchema.parse(process.env);
