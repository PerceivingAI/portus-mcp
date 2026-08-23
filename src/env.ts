import dotenv from "dotenv";
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH });

export function optionalEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
