const FALLBACK_API_BASE =
  "https://l8jfz274hk.execute-api.us-east-2.amazonaws.com";

export function resolveBeaverApiBase() {
  const fromEnv =
    process.env.BEAVER_API_BASE_URL ||
    process.env.NEXT_PUBLIC_BEAVER_API_BASE_URL ||
    process.env.AMPLIFY_BEAVER_API_BASE_URL;

  return {
    value: fromEnv || FALLBACK_API_BASE,
    source: fromEnv ? "env" : "fallback",
  };
}
