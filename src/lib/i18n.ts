import deUi from "../locales/de/ui.json";

type TranslationValue = string | TranslationMap;

interface TranslationMap {
  [key: string]: TranslationValue;
}

function lookup(path: string): string | null {
  const value = path
    .split(".")
    .reduce<TranslationValue | undefined>((current, segment) => {
      if (!current || typeof current === "string") {
        return undefined;
      }
      return current[segment];
    }, deUi as TranslationValue);

  return typeof value === "string" ? value : null;
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
