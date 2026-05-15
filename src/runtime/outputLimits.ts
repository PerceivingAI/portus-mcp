export const DEFAULT_TEXT_LIMIT = 120_000;

export type LimitedText = {
  text: string;
  bytes: number;
  truncated: boolean;
  limit: number;
};

export function limitText(text: string, limit = DEFAULT_TEXT_LIMIT): LimitedText {
  if (text.length <= limit) {
    return { text, bytes: text.length, truncated: false, limit };
  }

  return {
    text: `${text.slice(0, limit)}\n\n[truncated: ${text.length - limit} chars omitted]`,
    bytes: text.length,
    truncated: true,
    limit
  };
}
