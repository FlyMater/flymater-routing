// Observe one draft. The panel owns authentication and rendering; this module
// keeps polling, deadlines and stale-response protection in one place.
export async function observePreview({id, load, getRun, update, isCurrent,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  signalFor = ms => AbortSignal.timeout(ms)}) {
  const deadline = now() + 15 * 60 * 1000;
  let nextStatus = 0, status = "Ожидание запуска проверки…", url;
  const current = () => isCurrent() && now() < deadline;
  const notify = (message, verified = false) => {
    if (isCurrent()) update({message, verified, url});
  };
  const request = callback => callback(signalFor(Math.min(30000, Math.max(1, deadline - now()))));
  notify("Черновик сохранён. " + status);
  try {
    while (current()) {
      let result;
      try { result = await request(signal => load("preview/result.json", signal)); }
      catch (error) { if (error.status !== 404) throw error; }
      if (!current()) break;
      if (result?.id === id) {
        notify(result, result.issues.length === 0);
        return;
      }
      if (now() >= nextStatus) {
        nextStatus = now() + 60000;
        const latest = await request(signal => load("preview/request.json", signal));
        if (!current()) break;
        if (latest.id !== id) {
          notify("Черновик заменён другой проверкой. Загрузите актуальные настройки и повторите проверку.");
          return;
        }
        try {
          const run = await request(signal => getRun(signal));
          if (!current()) break;
          if (run) {
            url = run.html_url;
            if (run.status === "completed" && run.conclusion !== "success") {
              notify(run.conclusion === "cancelled" ? "Проверка отменена в GitHub Actions." :
                "Проверка завершилась с ошибкой в GitHub Actions: " + run.conclusion + ".");
              return;
            }
            status = run.status === "completed" ? "Проверка выполнена. Получение результата…" :
              run.status === "in_progress" ? "Проверка выполняется…" : "Проверка в очереди…";
            if (run.conclusion === "success") {
              // The run may have finished since the first read in this iteration.
              result = await request(signal => load("preview/result.json", signal));
              if (!current()) break;
              if (result.id === id) {
                notify(result, result.issues.length === 0);
                return;
              }
            }
          }
        } catch (error) {
          if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 429) {
            nextStatus = Math.max(nextStatus, error.retryAt || 0);
            status = error.status === 401 ? "GitHub не принял токен. Ожидание результата…" :
              error.status === 404 ? "Статус Actions пока недоступен. Ожидание результата…" :
              "Статус Actions недоступен. Проверьте право токена Actions → Read. Ожидание результата…";
            if (error.rateLimited || error.status === 429) status = "Лимит GitHub API исчерпан. " +
              "Повторите проверку после восстановления лимита.";
          } else throw error;
        }
      }
      notify(status);
      await sleep(Math.min(10000, Math.max(0, deadline - now())));
    }
    notify("Проверка не завершилась за 15 минут. Откройте GitHub Actions и повторите проверку.");
  } catch (error) {
    const message = error.name === "TimeoutError" || error.name === "AbortError"
      ? "Сервер не ответил за 30 секунд. Повторите загрузку страницы или проверку."
      : error.message;
    notify("Не удалось получить результат проверки. " + message);
  }
}
