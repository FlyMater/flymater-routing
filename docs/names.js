import {geosite} from "./geosite.js";

const aliases = new Map(Object.entries({
  telegram: "телеграм телеграмм",
  youtube: "ютуб ютьюб",
  whatsapp: "ватсап вотсап",
  discord: "дискорд",
  github: "гитхаб",
  google: "гугл",
  apple: "эппл",
  openai: "ChatGPT чатгпт",
  anthropic: "Claude клод",
  netflix: "нетфликс",
  instagram: "инстаграм",
  tiktok: "тикток",
  notion: "ноушен",
  zoom: "зум",
  pinterest: "пинтерест",
  microsoft: "майкрософт",
  "category-ai-!cn": "искусственный интеллект",
  "category-ads-all": "реклама",
  "category-games": "игровые сервисы"
}));
const regions = new Intl.DisplayNames(["ru"], {type:"region", fallback:"none"});

export const geositeCatalog = "https://github.com/SagerNet/sing-geosite/tree/rule-set";
let examples = new Map();

export function useGeositeExamples(rows) {
  examples = new Map(Object.entries(rows));
}

export function describe(tag, catalog) {
  if (catalog === geositeCatalog && tag.startsWith("geosite-")) {
    const key = tag.slice(8);
    const [service, variant] = key.split("@");
    const baseName = geosite.get(service)?.[0] ?? service.replaceAll("-", " ");
    const qualifiers = {ads: "реклама", telemetry: "телеметрия", cn: "материковый Китай", "!cn": "за пределами материкового Китая"};
    const fallbackName = variant ? `${baseName} · ${Object.hasOwn(qualifiers, variant) ? qualifiers[variant] : variant}` : baseName;
    const [name, purpose] = geosite.get(key) ?? [fallbackName, ""];
    const domains = examples.get(key) ?? [];
    const sample = domains.length ? `В набор ${domains.length === 1 ? "входит" : "входят"} ${domains.join(", ")}.` : "";
    const description = [purpose, sample].filter(Boolean).join(" ") || "Описание пока не добавлено";
    return {name, description, aliases: aliases.get(key) ?? ""};
  }
  if (catalog === "https://github.com/SagerNet/sing-geoip/tree/rule-set" && /^geoip-[a-z]{2}$/i.test(tag)) {
    const country = regions.of(tag.slice(6).toUpperCase());
    if (country) return {name: country + " · IP-адреса"};
  }
  return {name: tag};
}
