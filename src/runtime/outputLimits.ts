export const DEFAULT_TEXT_LIMIT = 120_000;

export type LimitedText = {
  text: string;
  chars: number;
  totalChars: number;
  omittedChars: number;
  truncated: boolean;
  limit: number;
};

export function countChars(text: string): number {
  return Array.from(text).length;
}

export function limitText(text: string, limit = DEFAULT_TEXT_LIMIT): LimitedText {
  const chars = Array.from(text);
  const totalChars = chars.length;
  if (totalChars <= limit) {
    return { text, chars: totalChars, totalChars, omittedChars: 0, truncated: false, limit };
  }

  const limited = chars.slice(0, limit).join("");
  return {
    text: limited,
    chars: limit,
    totalChars,
    omittedChars: totalChars - limit,
    truncated: true,
    limit
  };
}
