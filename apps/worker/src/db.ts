import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "./env.js";
import * as schema from "@cabalfinder/db";

const queryClient = postgres(env.DATABASE_URL, {
  max: 3,
  prepare: false
});

export const db = drizzle(queryClient, { schema });
