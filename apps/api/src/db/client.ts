import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../env.js";
import * as schema from "./schema.js";

const queryClient = postgres(env.DATABASE_URL, {
  max: 5,
  prepare: false
});

export const db = drizzle(queryClient, { schema });
