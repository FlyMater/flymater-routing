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
const policies = {proxy:"PROXY", direct:"DIRECT", reject:"REJECT", local:"Локальные исключения → DIRECT"};
const names = Object.keys(policies);
let active, config, sources, snapshot, latestId;
let activeTab = "sets";
const tabs = [...document.querySelectorAll('[role="tab"]')];
function activateTab(name) {
  activeTab = name;
  for (const tab of tabs) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = $(tab.getAttribute("aria-controls"));
    if (panel) panel.hidden = !selected;
  }
  document.querySelector('[aria-labelledby="selected-title"] .column-body').scrollTop = 0;
}
for (const [index, tab] of tabs.entries()) {
  tab.onclick = () => activateTab(tab.id.slice(4));
  tab.onkeydown = event => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  };
}
function workspaceSize() {
  const header = document.querySelector("header");
  const status = $("status");
  const style = getComputedStyle(status);
  // Resolve clamp() through the main's computed padding.
  const padding = parseFloat(getComputedStyle(document.querySelector("main")).paddingTop);
  const overhead = header.getBoundingClientRect().height + status.getBoundingClientRect().height +
    (style.display === "none" ? 0 : parseFloat(style.marginBottom)) + 2 * padding;
  document.documentElement.style.setProperty("--workspace-overhead", `${overhead}px`);
}
const workspaceObserver = new ResizeObserver(workspaceSize);
workspaceObserver.observe(document.querySelector("header"));
workspaceObserver.observe($("status"));
window.addEventListener("resize", workspaceSize);
workspaceSize();
function baseline(files) {
  return Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.sha]));
}
let entries = [], catalogRequest = 0;
function view(data, manual, id, base = baseline(sources)) {
  return {config:structuredClone(data), manual:{...manual}, base, id, verified:false, report:""};
}
let editingBusy = true;
function editorDisabled(disabled) {
  editingBusy = disabled;
  $("editor").disabled = disabled;
  $("catalogEditor").disabled = disabled;
  $("routeView").disabled = disabled;
  $("token").disabled = disabled && !!active;
  if (disabled) {
    $("check").disabled = true;
    $("publish").disabled = true;
  } else {
    controls();
  }
}
function controls() {
  if (!active) {
    $("check").disabled = true;
    $("publish").disabled = true;
    return;
  }
  $("check").disabled = !onPages || editingBusy;
  $("publish").disabled = !onPages || editingBusy || !sources || !active.verified || active.id !== latestId;
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
  options(); controls(); catalogOptions(); selected(); manualEditor();
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
    const detail = url.startsWith(api + "/") ? await response.json().catch(() => null) : null;
    const error = Error(`HTTP ${response.status} · ${response.status === 409 || response.status === 422 ? "Файл изменился. Перезагрузите настройки перед повтором." : detail?.message || url}`);
    error.status = response.status;
    error.rateLimited = response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after") || /rate limit/i.test(detail?.message || "");
    if (error.rateLimited || error.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      const retry = Number(response.headers.get("retry-after")) * 1000 + Date.now();
      error.retryAt = Math.max(reset || 0, retry || 0);
      error.message = "Достигнут лимит запросов GitHub. Откройте вкладку «Публикация», введите токен и повторите загрузку.";
    }
    throw error;
  }
  return response.json();
}
async function file(path, ref = branch) {
  const token = $("token").value.trim();
  const headers = token ? {Authorization:`Bearer ${token}`} : {};
  const blob = await json(`${api}/contents/${path}?ref=${ref}`, {headers, redirect:"error"});
  const text = new TextDecoder().decode(Uint8Array.from(atob(blob.content), c => c.charCodeAt(0)));
  return {sha:blob.sha, data:path.endsWith(".json") ? JSON.parse(text) : text};
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
  const tags = $("publishedTags");
  tags.replaceChildren();
  if (snapshot?.tags) {
    tags.append(node("h3", "Состав опубликованных подписок"));
    for (const [client, policies] of Object.entries(snapshot.tags)) {
      for (const [policy, names] of Object.entries(policies)) {
        tags.append(node("p", clients[client] + " · " + policy.toUpperCase() + " · " + names.map(name => "#" + name).join(" ")));
      }
    }
  }
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
}

function manualEditor() {
  const list = $("manual");
  list.replaceChildren();
  for (const [name, title] of Object.entries(policies)) {
    const panel = node("div");
    panel.id = `panel-${name}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `tab-${name}`);
    panel.tabIndex = 0;
    panel.hidden = activeTab !== name;
    const help = node("p", "По одному домену или IPv4/IPv6-подсети в строке, например 149.154.160.0/20. Строка #Telegramm начинает набор, строка с «# » — комментарий.");
    const label = node("label", title);
    const input = node("textarea");
    input.rows = 4;
    input.spellcheck = false;
    input.value = active.manual[name];
    input.oninput = () => {
      active.manual[name] = input.value;
      change();
    };
    label.append(input);
    panel.append(help, label);
    list.append(panel);
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
    const token = $("token").value.trim();
    const headers = token ? {Authorization:`Bearer ${token}`} : {};
    const tree = await json(`https://api.github.com/repos/${org}/${repoName}/git/trees/${ref}?recursive=1`, {headers});
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
  try {await fn();} catch (e) {
    report.textContent = e.rateLimited || e.status === 429
      ? "Достигнут лимит запросов GitHub. Откройте вкладку «Публикация», введите токен и повторите загрузку."
      : e.message;
  }
}
let buildRequest = 0, nextBuildCheck = 0;
async function buildStatus(force = false) {
  if (!force && Date.now() < nextBuildCheck) return;
  const request = ++buildRequest;
  const token = $("token").value.trim();
  nextBuildCheck = Date.now() + (token ? 60000 : 300000);
  const headers = token ? {Authorization:`Bearer ${token}`} : {};
  let data;
  try {
    const filter = expectedCommit ? "&head_sha="+encodeURIComponent(expectedCommit) : "";
    data = await json(`${api}/actions/workflows/generate.yml/runs?branch=main&per_page=1${filter}`, {headers, redirect:"error"});
  } catch (error) {
    if (request !== buildRequest) return;
    let message = error.message;
    if (error.rateLimited || error.status === 429) {
      nextBuildCheck = Math.max(nextBuildCheck, error.retryAt || 0, Date.now() + 300000);
      message = token ? "Достигнут лимит запросов GitHub. Статус обновится позже." :
        "Достигнут лимит запросов GitHub. Введите токен для просмотра статуса или повторите позже.";
    } else if (error.status === 403) {
      message = token ? "GitHub отказал в доступе к статусу. Проверьте право токена Actions → Read." :
        "GitHub отказал в доступе к статусу. Введите токен с правом Actions → Read.";
    } else if (error.status === 401) {
      message = "GitHub не принял токен. Проверьте его и срок действия.";
    } else if (error.status === 404) {
      message = "Сведения о сборке пока недоступны.";
    }
    const link = node("a", "Открыть сборки на GitHub ↗");
    link.href = `https://github.com/${repo}/actions/workflows/generate.yml`;
    $("build").replaceChildren(message + " ", link);
    return;
  }
  if (request !== buildRequest) return;
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
async function read(path, ref = branch) {
  // Public reads do not consume the GitHub API quota. Keep Git blob hashes
  // compatible with the authenticated conflict checks used during publication.
  const url = onPages ? `https://raw.githubusercontent.com/${repo}/${ref}/${path}` : "../" + path;
  const response = await fetch(url, {cache:"no-store"});
  if (!response.ok) {
    const error = Error(path + " · HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let sha;
  if (onPages) {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const blob = new Uint8Array(header.length + bytes.length);
    blob.set(header); blob.set(bytes, header.length);
    const hash = await crypto.subtle.digest("SHA-1", blob);
    sha = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,"0")).join("");
  }
  const text = new TextDecoder().decode(bytes);
  return {sha, data:path.endsWith(".json") ? JSON.parse(text) : text};
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
  editorDisabled(true);
  try {
    const base = baseline(sources);
    if (sourcePaths.some(path => state.base[path] !== base[path]) &&
        !window.confirm("Исходные файлы изменились со времени создания черновика. Проверить его для замены текущих настроек?")) return;
    let sha;
    try { sha = (await file("preview/request.json")).sha; } catch (e) { if (e.status !== 404) throw e; }
    await write("preview/request.json",{id,config:draft,manual:state.manual,base},sha,"Проверить черновик маршрутизации");
    state.base = base;
    latestId = id;
    state.id = id;
    state.verified = false;
    views.draft = state === views.draft ? state : view(draft,state.manual,id,state.base);
    options();
    void observe(id);
  } finally { editorDisabled(false); }
}, $("report"));
const sourcePaths = [configPath, ...names.map(name => `source/${name}.txt`)];
async function loadSources(ref) {
  const pairs = await Promise.all(sourcePaths.map(async path =>
    [path, onPages && ref ? await file(path, ref) : await read(path)]));
  return Object.fromEntries(pairs);
}

async function publish(state) {
  const token = $("token").value.trim();
  if (!token) throw Error("Введите GitHub-токен для публикации.");
  const headers = {Authorization:`Bearer ${token}`, "Content-Type":"application/json"};
  const head = await json(`${api}/git/ref/heads/${branch}`, {headers});
  const oid = head.object.sha;
  const [current, request] = await Promise.all([loadSources(oid), file("preview/request.json", oid)]);
  if (request.data.id !== state.id || sourcePaths.some(path => current[path].sha !== state.base[path])) {
    throw Error("Исходники или черновик изменились. Обновите страницу и повторите проверку.");
  }
  const additions = [];
  function addFile(path, text) {
    const bytes = new TextEncoder().encode(text);
    additions.push({path, contents:btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""))});
  }
  if (JSON.stringify(current[configPath].data) !== JSON.stringify(state.config)) {
    addFile(configPath, JSON.stringify(state.config, null, 2) + "\n");
  }
  for (const name of names) {
    const path = `source/${name}.txt`;
    if (state.manual[name] !== current[path].data) addFile(path, state.manual[name]);
  }
  if (!additions.length) {
    state.report = "Эти настройки уже сохранены.";
    return;
  }
  const input = {branch:{repositoryNameWithOwner:repo, branchName:branch}, expectedHeadOid:oid,
    message:{headline:"Обновить правила маршрутизации"}, fileChanges:{additions}};
  const result = await json("https://api.github.com/graphql", {method:"POST", headers, redirect:"error",
    body:JSON.stringify({query:"mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input:$input) { commit { oid } } }",
      variables:{input}})});
  if (result.errors?.length) throw Error(result.errors[0].message + " Обновите страницу перед повтором.");
  expectedCommit = result.data.createCommitOnBranch.commit.oid;
  change();
  state.report = "Настройки сохранены. Ожидается сборка подписок.";
  sources = await loadSources(expectedCommit);
  state.base = baseline(sources);
  await buildStatus(true);
}
$("publish").onclick = () => run(async () => {
  if ($("publish").disabled) return;
  if (snapshot && (JSON.stringify(sources[configPath].data) !== JSON.stringify(snapshot.config) ||
      names.some(name => snapshot.manualText && snapshot.manualText[name] !== sources[`source/${name}.txt`].data)) &&
      !window.confirm("Сохранённые настройки отличаются от опубликованного набора. Заменить их выбранной версией?")) return;
  editorDisabled(true);
  try { await publish(active); }
  finally { editorDisabled(false); }
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
let loadingSettings = false;
async function loadSettings() {
  if (loadingSettings || active) return;
  loadingSettings = true;
  $("reloadSettings").disabled = true;
  $("status").textContent = "Загрузка настроек…";
  try {
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
      loadSources()
    ]);
    sources = current;
    snapshot = published?.data;
    const raw = Object.fromEntries(names.map(name => [name, sources[`source/${name}.txt`].data]));
    if (snapshot) {
      const manual = {...raw};
      for (const name of names) {
        const values = raw[name].split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith("#"));
        if (JSON.stringify([...new Set(values)]) !== JSON.stringify(snapshot.manual[name])) {
          manual[name] = snapshot.manual[name].join("\n") + (snapshot.manual[name].length ? "\n" : "");
        }
      }
      views.published = view(snapshot.config, snapshot.manualText || manual);
    }
    if (request?.data?.id) {
      const draft = request.data;
      latestId = draft.id;
      views.draft = view(draft.config, draft.manual || raw, draft.manual && draft.base ? latestId : undefined, draft.base);
      if (!views.draft.id) views.draft.report = "Проверьте черновик перед публикацией.";
    }
    if (!views.published && !views.draft) {
      views.draft = view(sources[configPath].data, raw);
    }
    if (views.published || views.draft) {
      show(views.published ? "published" : "draft");
      editorDisabled(false);
      if (latestId) void observe(latestId);
    }
    $("status").textContent = warnings.join(" ");
    $("reloadSettings").hidden = true;
  } finally {
    loadingSettings = false;
    $("reloadSettings").disabled = false;
  }
}
$("reloadSettings").onclick = () => run(loadSettings);
$("token").onchange = () => { run(() => buildStatus(true)); if (!active) run(loadSettings); else run(refresh); };
run(loadSettings);
run(buildStatus);
setInterval(()=>{if(!document.hidden) run(buildStatus);},60000);
