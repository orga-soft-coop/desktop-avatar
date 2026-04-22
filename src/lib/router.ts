import type { PromptRoute } from "./contracts";

const businessKeywords = [
  "bestellung",
  "bestellungen",
  "auftrag",
  "auftraege",
  "aufträge",
  "order",
  "orders",
  "kunde",
  "kunden",
  "customer",
  "customers",
  "rechnung",
  "rechnungen",
  "invoice",
  "invoices",
  "bestand",
  "inventory",
  "lieferung",
  "lieferungen",
  "umsatz",
  "forecast",
  "prognose",
  "vorhersage",
  "next week",
  "naechste woche",
  "nächste woche"
];

const backendReviewKeywords = [
  "check",
  "prüf",
  "pruef",
  "schau",
  "lookup",
  "nachsehen",
  "gestern",
  "heute",
  "letzte",
  "overnight",
  "night",
  "status",
  "zahlen"
];

const casualKeywords = [
  "hallo",
  "hello",
  "hi",
  "wer bist du",
  "who are you",
  "tell me a joke",
  "witz",
  "write",
  "schreib",
  "explain",
  "erklär",
  "erkläre",
  "how are you"
];

export function routePrompt(prompt: string): PromptRoute {
  const normalized = prompt.toLowerCase();

  if (businessKeywords.some((keyword) => normalized.includes(keyword))) {
    return "backendBusiness";
  }

  if (casualKeywords.some((keyword) => normalized.includes(keyword))) {
    return "localChat";
  }

  if (backendReviewKeywords.some((keyword) => normalized.includes(keyword))) {
    return "backendReview";
  }

  return "localChat";
}
