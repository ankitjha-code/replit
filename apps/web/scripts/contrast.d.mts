export type TokenSet = Record<string, string>;
export interface ContrastRow {
  theme: string;
  fg: string;
  fgHex: string;
  bg: string;
  bgHex: string;
  ratio: number;
  req: number;
  ok: boolean;
  note: string;
}
export const dark: TokenSet;
export const light: TokenSet;
export const pairs: Array<[string, string, number, string]>;
export function ratio(a: string, b: string): number;
export function measure(sets?: Record<string, TokenSet>): { fail: number; rows: ContrastRow[] };
