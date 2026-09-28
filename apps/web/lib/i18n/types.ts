import type { en } from "./en";

/** CLDR plural categories; `other` is the only one every language has. */
export type PluralForms = { other: string } & Partial<Record<Exclude<Intl.LDMLPluralRule, "other">, string>>;

type En = typeof en;

export type MessageKey = keyof En;
export type PluralKey = { [K in MessageKey]: En[K] extends string ? never : K }[MessageKey];
export type TextKey = Exclude<MessageKey, PluralKey>;

/**
 * Shape every translation must match: exactly the English keys, strings where English has a string
 * and plural forms where English has plural forms. Missing or extra keys fail type-checking.
 */
export type Dict = { [K in MessageKey]: En[K] extends string ? string : PluralForms };

export type Vars = Record<string, string | number>;

export interface Translator {
  (key: TextKey, vars?: Vars): string;
  (key: PluralKey, vars: Vars & { count: number }): string;
}
