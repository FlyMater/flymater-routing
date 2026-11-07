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
let config, revision, entries = [], checked, generation = 0, catalogRequest = 0;
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
    const error = Error(`HTTP ${response.status} · ${response.status === 409 || response.status === 422 ? "Файл изменился. Перезагрузите настройки перед повтором." : url}`);
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
  generation++;
  checked = undefined;
  $("publish").disabled = true;
  $("report").textContent = "Есть изменения. Проверьте черновик перед публикацией.";
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
  if (!config.sets.length) list.append(node("p","Пока используются только ручные списки."));
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
    row.append(titleFor(item.tag, item.catalog, item.name || defaultName), policy, rename, remove, node("small",item.url));
    const targets = node("div"); targets.className = "clients";
    for (const [key,title] of Object.entries(clients)) {
      const label = node("label"), input = node("input");
      input.type = "checkbox"; input.disabled = key === "ndms" && item.policy !== "proxy";
      input.checked = !input.disabled && !item.exclude.includes(key);
      input.onchange = () => {item.exclude = input.checked ? item.exclude.filter(c => c!==key) : [...item.exclude,key];change();};
      label.append(input, title); targets.append(label);
    }
    row.append(targets); list.append(row);
  }
}
function catalogOptions(active) {
  $("catalog").replaceChildren(...config.catalogs.map(c => new Option(c.name,c.url)));
  if (active) $("catalog").value = active;
}
async function refresh() {
  const id = ++catalogRequest, url = $("catalog").value;
  entries = []; $("matches").replaceChildren(); $("catalogState").textContent = "Загрузка каталога…";
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
  const byTag = new Map(rows.map(row => [row.tag, row]));
  for (const item of config.sets) {
    const row = byTag.get(item.tag);
    if (item.catalog === url && row?.url === item.url && item.catalogName !== row.name) {
      item.catalogName = row.name;
      change();
    }
  }
  matches(); selected();
  const missing = config.sets.filter(s => s.catalog === url && !rows.some(r => r.tag===s.tag && r.url===s.url));
  if (missing.length) { change(); throw Error("Наборы исчезли или сменили URL: "+missing.map(s=>s.tag).join(", ")); }
}
async function run(fn) {
  try {await fn();} catch (e) {$("status").textContent = e.message;}
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
$("check").onclick = () => run(async () => {
  change();
  const version = generation, id = crypto.randomUUID();
  let sha;
  try {sha = (await file("preview/request.json")).sha;} catch(e) {if(e.status!==404) throw e;}
  await write("preview/request.json",{id,config},sha,"Проверить черновик маршрутизации");
  $("report").textContent = "Черновик сохранён. Ожидание проверки в GitHub Actions…";
  for (let i=0; i<90 && version===generation; i++) {
    await new Promise(resolve => setTimeout(resolve,10000));
    if(version!==generation) return;
    let result;
    try {result = (await file("preview/result.json")).data;} catch(e) {if(e.status!==404) throw e;}
    if(version!==generation) return;
    if(result?.id!==id) continue;
    if(result.issues.length) { $("report").textContent=result.issues.join("\n"); return; }
    checked=version; $("publish").disabled=false; $("report").textContent="Все выбранные назначения совместимы."; return;
  }
  if(version===generation) $("report").textContent="Проверка не завершилась. Проверьте workflow «Проверка выбранных наборов» и повторите.";
});
$("publish").onclick = () => run(async () => {
  if(checked!==generation) return;
  $("editor").disabled=true;
  try {
    const result=await write(configPath,config,revision,"Обновить назначения наборов маршрутизации");
    revision=result.content.sha;
    expectedCommit=result.commit?.sha;
    change(); $("report").textContent="Настройки сохранены. Ожидается сборка подписок.";
    await buildStatus();
  } finally { $("editor").disabled=false; }
});
$("refresh").onclick = $("catalog").onchange = () => run(refresh);
$("query").oninput = matches;
$("addSet").onsubmit = e => {e.preventDefault();run(()=>{add($("tag").value,$("setUrl").value,null);e.target.reset();});};
$("addCatalog").onsubmit = e => {e.preventDefault();run(async ()=>{
  const url=safeUrl($("catalogUrl").value), name=$("catalogName").value.trim();
  if(!name || config.catalogs.some(c=>c.url===url)) throw Error("Укажите название и новый URL каталога");
  config.catalogs.push({url,name});catalogOptions(url);change();e.target.reset();await refresh();
});};
$("repo").href=`https://github.com/${repo}`;
run(async ()=>{
  const current=onPages ? await file(configPath) : {data:await json("../source/routing.json")};
  config=current.data;revision=current.sha;
  if (!onPages) {
    $("check").disabled=true;
    $("report").textContent="Локальный просмотр. Проверка и публикация доступны на GitHub Pages.";
  }
  catalogOptions();selected();$("editor").disabled=false;$("status").textContent="Настройки загружены из "+repo;
  await refresh();
});
run(buildStatus);
setInterval(()=>{if(!document.hidden) run(buildStatus);},60000);
