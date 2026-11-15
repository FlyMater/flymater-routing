import {observePreview} from "../docs/preview.js";

export async function runTests() {
  const results = [];
  const assert = (condition, message = "Условие не выполнено") => {
    if (!condition) throw Error(message);
  };
  const fail = (status, message = "Ошибка сети") => Object.assign(Error(message), {status});
  const done = (issues = []) => ({id:"draft", issues, coverage:[]});
  const run = (status, conclusion) => ({status, conclusion, html_url:"https://github.com/example/run/1"});
  async function scenario(overrides = {}) {
    let time = 0;
    const updates = [], signals = [], sleeps = [];
    const options = {id:"draft", now:() => time,
      sleep:async ms => { sleeps.push(ms); time += ms; },
      signalFor:ms => { signals.push(ms); return AbortSignal.timeout(ms); },
      isCurrent:() => true, update:value => updates.push(value),
      load:async path => path.endsWith("request.json") ? {id:"draft"} : done(),
      getRun:async () => undefined, ...overrides};
    await observePreview(options);
    return {updates, signals, sleeps, last:updates.at(-1), time};
  }
  async function test(name, fn) {
    try { await fn(); results.push({name, passed:true}); }
    catch (error) { results.push({name, passed:false, error:error.stack}); }
  }
  await test("Готовый результат после перезагрузки доступен без запроса Actions", async () => {
    const out = await scenario({getRun:() => { throw Error("Лишний запрос"); }});
    assert(out.last.verified && out.sleeps.length === 0);
  });
  await test("Ошибки проверки блокируют публикацию", async () => {
    const out = await scenario({load:async () => done(["Конфликт маршрутов"])});
    assert(!out.last.verified && out.last.message.issues[0] === "Конфликт маршрутов");
  });
  await test("Старый результат заменяется свежим через 10 секунд", async () => {
    let reads = 0;
    const out = await scenario({load:async path => path.endsWith("request.json") ? {id:"draft"} :
      ++reads === 1 ? {id:"old"} : done()});
    assert(out.last.verified && out.time === 10000);
  });
  for (const [status, label] of [["queued", "очереди"], ["in_progress", "выполняется"]]) {
    await test("Отображается статус " + status, async () => {
      let reads = 0;
      const out = await scenario({load:async path => path.endsWith("request.json") ? {id:"draft"} :
        ++reads === 1 ? {id:"old"} : done(), getRun:async () => run(status)});
      assert(out.updates.some(item => typeof item.message === "string" && item.message.includes(label) && item.url));
      assert(out.last.verified);
    });
  }
  await test("Завершение Actions вызывает немедленное повторное чтение", async () => {
    let reads = 0;
    const out = await scenario({load:async path => path.endsWith("request.json") ? {id:"draft"} :
      ++reads === 1 ? {id:"old"} : done(), getRun:async () => run("completed", "success")});
    assert(out.last.verified && out.time === 0 && reads === 2);
  });
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    await test("Завершение Actions: " + conclusion, async () => {
      const out = await scenario({load:async path => ({id:path.endsWith("request.json") ? "draft" : "old"}),
        getRun:async () => run("completed", conclusion)});
      assert(!out.last.verified && out.last.url && out.sleeps.length === 0);
    });
  }
  await test("Другая вкладка заменила черновик", async () => {
    const out = await scenario({load:async () => ({id:"other"})});
    assert(!out.last.verified && out.last.message.includes("заменён") && out.time === 0);
  });
  for (const stage of ["result", "request", "run"]) {
    await test("Новая проверка или редактирование во время запроса: " + stage, async () => {
      let current = true;
      const out = await scenario({isCurrent:() => current,
        load:async path => {
          if (stage === "result" || (stage === "request" && path.endsWith("request.json"))) current = false;
          return path.endsWith("request.json") ? {id:"draft"} : {id:"old"};
        }, getRun:async () => { current = false; return run("completed", "failure"); }});
      assert(out.updates.length === 1, "Устаревший ответ изменил состояние");
    });
  }
  await test("404 результата допускает ожидание нового файла", async () => {
    let reads = 0;
    const out = await scenario({load:async path => {
      if (path.endsWith("request.json")) return {id:"draft"};
      if (++reads === 1) throw fail(404);
      return done();
    }});
    assert(out.last.verified && out.time === 10000);
  });
  for (const status of [401, 403, 429, undefined]) {
    await test("Ошибка получения результата: " + status, async () => {
      const out = await scenario({load:async () => { throw fail(status); }});
      assert(!out.last.verified && out.last.message.includes("Не удалось получить") && out.time === 0);
    });
  }
  await test("Таймаут сетевого запроса отображается в отчёте", async () => {
    const out = await scenario({load:async () => { throw new DOMException("timeout", "TimeoutError"); }});
    assert(out.signals[0] === 30000 && out.last.message.includes("30 секунд"));
  });
  await test("Отказ Actions не мешает получить готовый результат", async () => {
    let reads = 0;
    const out = await scenario({load:async path => path.endsWith("request.json") ? {id:"draft"} :
      ++reads === 1 ? {id:"old"} : done(), getRun:async () => { throw fail(403); }});
    assert(out.last.verified && out.updates.some(item => String(item.message).includes("Actions → Read")));
  });
  await test("Ожидание ограничено 15 минутами, Actions опрашивается раз в минуту", async () => {
    let runs = 0;
    const out = await scenario({load:async path => ({id:path.endsWith("request.json") ? "draft" : "old"}),
      getRun:async () => { runs++; }});
    assert(out.time === 900000 && runs === 15 && !out.last.verified);
    assert(out.last.message.includes("15 минут"));
  });
  return results;
}
