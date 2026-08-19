/** Current DeepSeek official OpenAI-compatible base URL. */
export const DEEPSEEK_OFFICIAL_BASE_URL = "https://api.deepseek.com";
/** Default DeepSeek model for routine coding/benchmark runs. */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
/** Stronger DeepSeek model for confirmation runs. */
export const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";
/** Current official DeepSeek model ids exposed by the built-in provider preset. */
export const DEEPSEEK_OFFICIAL_MODELS = [DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_PRO_MODEL] as const;
