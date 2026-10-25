/** 中英文混合分词：英文按词，中文按双字 gram。 */
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens: string[] = [];
  for (const chunk of normalized.split(/\s+/)) {
    if (/^[a-z0-9]+$/.test(chunk)) {
      tokens.push(chunk);
    } else {
      for (let i = 0; i < chunk.length - 1; i++) {
        tokens.push(chunk.slice(i, i + 2));
      }
    }
  }
  return tokens;
}
