const services = new Map(Object.entries({
  telegram: ["Telegram", "телеграм телеграмм"],
  youtube: ["YouTube", "ютуб ютьюб"],
  whatsapp: ["WhatsApp", "ватсап вотсап"],
  discord: ["Discord", "дискорд"],
  github: ["GitHub", "гитхаб"],
  google: ["Google", "гугл"],
  apple: ["Apple", "эппл"],
  openai: ["OpenAI", "ChatGPT чатгпт"],
  anthropic: ["Anthropic", "Claude клод"],
  netflix: ["Netflix", "нетфликс"],
  instagram: ["Instagram", "инстаграм"],
  tiktok: ["TikTok", "тикток"],
  notion: ["Notion", "ноушен"],
  zoom: ["Zoom", "зум"],
  pinterest: ["Pinterest", "пинтерест"],
  microsoft: ["Microsoft", "майкрософт"],
  "category-ai-!cn": ["Сервисы ИИ за пределами Китая", "искусственный интеллект"],
  "category-ads-all": ["Рекламные сети", "реклама"],
  "category-games": ["Игры", "игровые сервисы"]
}));
const regions = new Intl.DisplayNames(["ru"], {type:"region", fallback:"none"});

export function describe(tag, catalog) {
  if (catalog === "https://github.com/SagerNet/sing-geosite/tree/rule-set" && tag.startsWith("geosite-")) {
    return services.get(tag.slice(8)) || [tag, ""];
  }
  if (catalog === "https://github.com/SagerNet/sing-geoip/tree/rule-set" && /^geoip-[a-z]{2}$/i.test(tag)) {
    const country = regions.of(tag.slice(6).toUpperCase());
    if (country) return [country + " · IP-адреса", ""];
  }
  return [tag, ""];
}
