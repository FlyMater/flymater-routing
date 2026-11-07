import {describe, geositeCatalog, useGeositeExamples} from "./names.js";
const $ = id => document.getElementById(id);
const onPages = location.hostname.endsWith(".github.io");
const owner = onPages ? location.hostname.split(".")[0] : "FlyMater";
const repository = onPages ? location.pathname.split("/")[1] : "flymater-routing";
const repo = `${owner}/${repository}`;
const api = `https://api.github.com/repos/${repo}`;
const branch = "main";
const configPath = "source/routing.json";
const clients = {singbox:"AWG sing-box", ndms:"AWG NDMS", shadowrocket:"Shadowrocket", throne:"Throne"};
let expectedCommit;
const views = {};
let active, config, revision, savedConfig, snapshot, latestId;
let entries = [], catalogRequest = 0;
function view(data, id) {
  return {config:structuredClone(data), id, verified:false, report:""};
}
function controls() {
  $("check").disabled = !onPages;
  $("publish").disabled = !onPages || !revision || !active.verified || active.id !== latestId;
  $("report").textContent = active.report;
  if (!onPages) {
    const pages = node("a", "Открыть панель на GitHub Pages");
    pages.href = `https://${owner.toLowerCase()}.github.io/${repository}/`;
    $("report").append(" Локальный просмотр. ", pages);
  }
}
function options() {
  const select = $("routeView");
  select.replaceChildren();
  if (views.published) select.add(new Option("Опубликованный набор","published"));
  if (views.draft) select.add(new Option("Последний черновик","draft"));
  select.hidden = !views.draft;
  select.value = active === views.published ? "published" : "draft";
}
function show(key) {
  active = views[key];
  config = active.config;
  options(); controls(); catalogOptions(); selected();
  refresh();
}
$("routeView").onchange = event => show(event.target.value);
function node(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw Error("Нужна общедоступная HTTPS-ссылка");
  return url.href;
}
async function json(url, options = {}) {
  const response = await fetch(url, {cache:"no-store", ...options});
  if (!response.ok) {
    const detail = url.startsWith(api + "/contents/") ? await response.json().catch(() => null) : null;
    const error = Error(`HTTP ${response.status} · ${response.status === 409 || response.status === 422 ? "Файл изменился. Перезагрузите настройки перед повтором." : detail?.message || url}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
async function file(path) {
  const token = $("token").value.trim();
  const headers = token ? {Authorization:`Bearer ${token}`} : {};
  const blob = await json(`${api}/contents/${path}?ref=${branch}`, {headers, redirect:"error"});
  return {sha:blob.sha, data:JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(blob.content), c => c.charCodeAt(0))))};
}
async function write(path, value, sha, message) {
  const token = $("token").value.trim();
  if (!token) throw Error("Введите GitHub-токен с правом записи в репозиторий");
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2)+"\n");
  const content = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
  return json(`${api}/contents/${path}`, {method:"PUT", redirect:"error", headers:{Authorization:`Bearer ${token}`, "Content-Type":"application/json"},
    body:JSON.stringify({branch, message, sha, content})});
}
function change() {
  active.id = undefined;
  active.verified = false;
  active.report = "Есть изменения. Проверьте черновик перед публикацией.";
  controls();
}
function titleFor(tag, catalog, customName) {
  const {name, description} = describe(tag, catalog);
  const title = customName || name;
  const info = node("div");
  info.className = "set-info";
  info.append(node("strong", title));
  if (description) info.append(node("span", description));
  if (description || title !== tag) info.append(node("code", tag));
  return info;
}
function add(tag, url, catalog, catalogName) {
  url = safeUrl(url);
  if (!tag.trim() || config.sets.some(s => s.url === url)) throw Error("Укажите тег и ссылку на новый набор");
  config.sets.push({tag:tag.trim(), url, catalog, catalogName, policy:"proxy", exclude:[]});
  change(); selected(); matches();
}
function matches() {
  const query = $("query").value.trim().toLowerCase();
  const catalog = $("catalog").value;
  const chosen = new Map(config.sets.map(item => [item.url, item]));
  const filtered = entries.filter(entry => {
    const {name, description, aliases} = describe(entry.tag, catalog);
    const words = [entry.tag, entry.name, chosen.get(entry.url)?.name, name, description, aliases];
    return words.join(" ").toLowerCase().includes(query);
  });
  $("matches").replaceChildren();
  $("catalogState").textContent = `Найдено: ${filtered.length}. Показано: ${Math.min(100,filtered.length)}.`;
  for (const {tag,url,name} of filtered.slice(0,100)) {
    const row = node("article"), btn = node("button","Добавить");
    btn.disabled = chosen.has(url);
    btn.onclick = () => run(() => add(tag,url,catalog,name));
    row.append(titleFor(tag, catalog, chosen.get(url)?.name || name),btn); $("matches").append(row);
  }
}
function selected() {
  const list = $("selected"); list.replaceChildren();
  if (!config.sets.length) list.append(node("p","Наборы каталогов не выбраны."));
  for (const item of config.sets) {
    const row = node("article"), policy = node("select"), remove = node("button","Удалить");
    policy.setAttribute("aria-label",`Маршрут для ${item.tag}`);
    for (const p of ["proxy","direct","reject"]) policy.add(new Option(p.toUpperCase(),p));
    policy.value = item.policy;
    policy.onchange = () => {item.policy = policy.value; change(); selected();};
    remove.onclick = () => {config.sets.splice(config.sets.indexOf(item),1);change();selected();matches();};
    const defaultName = item.catalogName || describe(item.tag, item.catalog).name;
    const rename = node("button", "Переименовать");
    rename.onclick = () => {
      const value = window.prompt("Своё название. Очистите поле, чтобы вернуть исходное.", item.name || defaultName);
      if (value === null) return;
      if (value.trim()) item.name = value.trim();
      else delete item.name;
      change(); selected(); matches();
    };
    row.append(titleFor(item.tag, item.catalog, item.name || entries.find(row => row.url === item.url)?.name || defaultName), policy, rename, remove, node("small",item.url));
    const targets = node("div"); targets.className = "clients";
    for (const [key,title] of Object.entries(clients)) {
      const label = node("label"), input = node("input");
      input.type = "checkbox"; input.disabled = key === "ndms" && item.policy !== "proxy";
      input.checked = !input.disabled && !item.exclude.includes(key);
      input.onchange = () => {item.exclude = input.checked ? item.exclude.filter(c => c!==key) : [...item.exclude,key];change();};
      label.append(input, input.disabled ? title + " (только PROXY)" : title); targets.append(label);
    }
    row.append(targets); list.append(row);
  }
  if (!snapshot) return;
  const labels = {proxy:"PROXY", direct:"DIRECT", reject:"REJECT", local:"Локальные исключения → DIRECT"};
  const groups = Object.entries(snapshot.manual).filter(([, domains]) => domains.length);
  if (groups.length) list.append(node("h3","Ручные правила"));
  if (groups.length && active === views.draft) list.append(node("p","Из опубликованной сборки"));
  for (const [policy, domains] of groups) {
    const group = node("details");
    group.append(node("summary", labels[policy] + " · " + domains.length), node("p", domains.join(", ")));
    list.append(group);
  }
}
function catalogOptions(active) {
  $("catalog").replaceChildren(...config.catalogs.map(c => new Option(c.name,c.url)));
  if (active) $("catalog").value = active;
}
async function refresh() {
  const id = ++catalogRequest, url = $("catalog").value;
  entries = []; $("matches").replaceChildren(); $("catalogState").textContent = "Загрузка каталога…";
  if (!url) {
    $("catalogState").textContent = "Каталоги не добавлены.";
    return;
  }
  try {
    await loadCatalog(id, url);
  } catch (error) {
    if (id === catalogRequest) $("catalogState").textContent = error.message;
  }
}
async function loadCatalog(id, url) {
  const u = new URL(safeUrl(url));
  let rows;
  if (u.hostname === "github.com") {
    const m = u.pathname.replace(/\/$/,"").match(/^\/([\w.-]+)\/([\w.-]+)\/tree\/([^/]+)(?:\/(.*))?$/);
    if (!m) throw Error("Выберите папку GitHub в конкретной ветке");
    const [,org,repoName,ref,dir] = m, prefix = dir ? decodeURIComponent(dir)+"/" : "";
    const tree = await json(`https://api.github.com/repos/${org}/${repoName}/git/trees/${ref}?recursive=1`);
    if (tree.truncated) throw Error("GitHub вернул неполный каталог");
    rows = tree.tree.filter(e => e.type==="blob" && e.path.startsWith(prefix) && /\.(srs|json)$/.test(e.path)).map(e => ({
      tag:e.path.slice(prefix.length).replace(/\.(srs|json)$/,""),
      url:`https://raw.githubusercontent.com/${org}/${repoName}/${ref}/${e.path.split("/").map(encodeURIComponent).join("/")}`}));
  } else rows = (await json(url)).sets;
  const tags = new Set();
  for (const row of rows) {
    safeUrl(row.url);
    if (!row.tag?.trim() || tags.has(row.tag)) throw Error("Пустой или повторный тег в каталоге");
    row.name = typeof row.name === "string" ? row.name.trim() || undefined : undefined;
    tags.add(row.tag);
  }
  if (url === geositeCatalog || config.sets.some(item => item.catalog === geositeCatalog)) {
    const bundled = new URL("./geosite-examples.json", import.meta.url);
    let samples;
    try {
      samples = onPages
        ? await json(`https://raw.githubusercontent.com/${repo}/${branch}/docs/geosite-examples.json`)
        : await json(bundled);
    } catch (error) {
      if (!onPages) throw error;
      samples = await json(bundled);
    }
    if (id !== catalogRequest) return;
    useGeositeExamples(samples);
  }
  if (id !== catalogRequest) return;
  entries = rows;
  matches(); selected();
  const missing = config.sets.filter(s => s.catalog === url && !rows.some(r => r.tag===s.tag && r.url===s.url));
  if (missing.length) { throw Error("Наборы исчезли или сменили URL: "+missing.map(s=>s.tag).join(", ")); }
}
async function run(fn, report = $("status")) {
  try {await fn();} catch (e) {report.textContent = e.message;}
}
async function buildStatus() {
  let data;
  try {
    const filter = expectedCommit ? "&head_sha="+encodeURIComponent(expectedCommit) : "";
    data = await json(`${api}/actions/workflows/generate.yml/runs?branch=main&per_page=1${filter}`);
  } catch (error) {
    $("build").textContent = error.status === 404 ? "Сведения о сборке пока недоступны." : error.message;
    return;
  }
  const run = data.workflow_runs[0];
  if (!run) {
    $("build").textContent = expectedCommit ? "Ожидание запуска для сохранённых настроек…" : "Сборок пока нет.";
    return;
  }
  if (run.conclusion) expectedCommit = undefined;
  const link = node("a",`Сборка №${run.run_number} ↗`); link.href = run.html_url;
  const labels = {success:"успешно",failure:"ошибка",in_progress:"выполняется",queued:"в очереди",cancelled:"отменена"};
  $("build").replaceChildren(link," · "+(labels[run.conclusion || run.status] || run.status)+" · "+new Date(run.created_at).toLocaleString("ru"));
}
async function read(path) {
  return onPages ? file(path) : {data:await json("../" + path)};
}
async function observe(id) {
  const update = (report, verified = false) => {
    for (const state of Object.values(views)) {
      if (state.id === id) Object.assign(state, {report, verified});
    }
    if (active?.id === id) controls();
  };
  update("Черновик сохранён. Ожидание результата проверки…");
  for (let attempt = 0; attempt < 90 && latestId === id; attempt++) {
    let result;
    try { result = (await read("preview/result.json")).data; }
    catch (error) {
      if (error.status !== 404) {
        if (latestId === id) update("Не удалось загрузить результат проверки. " + error.message);
        return;
      }
    }
    if (latestId !== id) return;
    if (result?.id === id) {
      const rows = (result.coverage || []).map(({tag, client, status, skipped}) =>
        `${tag} → ${clients[client]}: ${status}${skipped.length ? ". Пропущено: " + skipped.join(", ") : ""}`);
      const ok = result.issues.length === 0;
      update([ok ? "Проверка завершена." : "Публикация заблокирована.", ...result.issues, ...rows].join("\n"), ok);
      return;
    }
    await new Promise(resolve => setTimeout(resolve,10000));
  }
  if (latestId === id) update("Проверка не завершилась. Проверьте workflow и повторите.");
}
$("check").onclick = () => run(async () => {
  if (!$("token").value.trim()) throw Error("Введите GitHub-токен для проверки черновика.");
  const state = active, draft = structuredClone(config), id = crypto.randomUUID();
  $("editor").disabled = true;
  try {
    let sha;
    try { sha = (await file("preview/request.json")).sha; } catch (e) { if (e.status !== 404) throw e; }
    await write("preview/request.json",{id,config:draft},sha,"Проверить черновик маршрутизации");
    latestId = id;
    state.id = id;
    state.verified = false;
    views.draft = state === views.draft ? state : view(draft,id);
    options();
    void observe(id);
  } finally { $("editor").disabled = false; controls(); }
}, $("report"));
$("publish").onclick = () => run(async () => {
  if ($("publish").disabled) return;
  if (snapshot && JSON.stringify(savedConfig) !== JSON.stringify(snapshot.config) &&
      !window.confirm("Сохранённые настройки отличаются от опубликованного набора. Заменить их выбранной версией?")) return;
  $("editor").disabled=true;
  try {
    const result=await write(configPath,config,revision,"Обновить назначения наборов маршрутизации");
    revision=result.content.sha;
    savedConfig=structuredClone(config);
    expectedCommit=result.commit?.sha;
    change();
    active.report="Настройки сохранены. Ожидается сборка подписок.";
    controls();
    await buildStatus();
  } finally { $("editor").disabled=false; }
}, $("report"));
$("refresh").onclick = $("catalog").onchange = refresh;
$("query").oninput = matches;
$("addSet").onsubmit = e => {e.preventDefault();run(()=>{add($("tag").value,$("setUrl").value,null);e.target.reset();});};
$("addCatalog").onsubmit = e => {e.preventDefault();run(async ()=>{
  const url=safeUrl($("catalogUrl").value), name=$("catalogName").value.trim();
  if(!name || config.catalogs.some(c=>c.url===url)) throw Error("Укажите название и новый URL каталога");
  config.catalogs.push({url,name});catalogOptions(url);change();e.target.reset();await refresh();
});};
$("repo").href=`https://github.com/${repo}`;
run(async ()=>{
  const warnings = [];
  async function load(path, label, optional = false) {
    try { return await read(path); }
    catch (error) {
      if (!optional || error.status !== 404) warnings.push(label + ". " + error.message);
    }
  }
  const [published, request, current] = await Promise.all([
    load("docs/published-routes.json","Не удалось загрузить опубликованный набор"),
    load("preview/request.json","Не удалось загрузить последний черновик",true),
    load(configPath,"Не удалось загрузить сохранённую конфигурацию")
  ]);
  revision = current?.sha;
  savedConfig = current?.data;
  snapshot = published?.data;
  if (snapshot) views.published = view(snapshot.config);
  if (request?.data?.id) {
    latestId = request.data.id;
    views.draft = view(request.data.config,latestId);
  }
  if (views.published || views.draft) {
    show(views.published ? "published" : "draft");
    $("editor").disabled=false;
    if (latestId) void observe(latestId);
  }
  $("status").textContent = warnings.join(" ") || "Настройки загружены из " + repo;
});
run(buildStatus);
setInterval(()=>{if(!document.hidden) run(buildStatus);},60000);
