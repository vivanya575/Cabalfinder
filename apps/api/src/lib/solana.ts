import bs58 from "bs58";
import { AppError } from "./errors.js";

export function assertValidSolanaMint(mint: string): string {
  const trimmed = mint.trim();

  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 32) {
      throw new Error("Invalid address length");
    }
  } catch {
    throw new AppError(400, "mint must be a valid 32-byte Solana address.");
  }

  return trimmed;
}
