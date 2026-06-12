import deUi from "../locales/de/ui.json";
import enUi from "../locales/en/ui.json";

type TranslationValue = string | TranslationMap;
export type LocaleId = "de" | "en";

const LOCALE_STORAGE_KEY = "desktop-avatar.locale";
const DEFAULT_LOCALE: LocaleId = "de";
const dictionaries: Record<LocaleId, TranslationMap> = {
  de: deUi as TranslationMap,
  en: enUi as TranslationMap,
};

interface TranslationMap {
  [key: string]: TranslationValue;
}

export const supportedLocales = Object.keys(dictionaries) as LocaleId[];

function isLocaleId(value: string | null | undefined): value is LocaleId {
  return value === "de" || value === "en";
}

function normalizeLocale(value: string | null | undefined): LocaleId {
  if (!value) {
    return DEFAULT_LOCALE;
  }
  const normalized = value.trim().toLowerCase().split("-")[0] ?? "";
  return isLocaleId(normalized) ? normalized : DEFAULT_LOCALE;
}

function readStoredLocale(): LocaleId {
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }
  return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
}

let currentLocale: LocaleId = readStoredLocale();

function lookupIn(dictionary: TranslationMap, path: string): string | null {
  const value = path
    .split(".")
    .reduce<TranslationValue | undefined>((current, segment) => {
      if (!current || typeof current === "string") {
        return undefined;
      }
      return current[segment];
    }, dictionary as TranslationValue);

  return typeof value === "string" ? value : null;
}

function lookup(path: string): string | null {
  return (
    lookupIn(dictionaries[currentLocale], path) ??
    lookupIn(dictionaries[DEFAULT_LOCALE], path)
  );
}

export function getLocale(): LocaleId {
  return currentLocale;
}

export function setLocale(locale: string): LocaleId {
  currentLocale = normalizeLocale(locale);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, currentLocale);
  }
  return currentLocale;
}

export function t(
  key: string,
  replacements: Record<string, string | number> = {}
): string {
  const template = lookup(key) ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    replacements[name] === undefined ? "" : String(replacements[name])
  );
}
