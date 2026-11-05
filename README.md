# FlyMater Routing

Управляемые из GitHub правила для AWG Manager (Keenetic/Netcraze), Shadowrocket (iPhone/macOS), Throne (Windows 11).

## 1. Публикация

1. Создайте **публичный** репозиторий `flymater-routing` на GitHub.
2. Загрузите **содержимое** этого ZIP в корень репозитория; используйте Commit changes. В веб-интерфейсе GitHub скрытая папка `.github` может потребовать загрузки через git или добавления файла вручную.
3. Откройте Actions и разрешите выполнение workflow `Generate routing profiles` (если GitHub предлагает).
4. В Settings → Actions → General → Workflow permissions выберите **Read and write permissions**; это необходимо, чтобы Actions могли коммитить сгенерированные файлы. Если политика аккаунта запрещает запись, используйте локальный запуск `python scripts/generate.py` и коммитьте результат сами.
5. После изменения файлов в `source/` проверьте зелёный статус Actions и актуальные `awg/`, `shadowrocket/`, `throne/`.

## 2. URL

Замените `USERNAME` на логин GitHub:

- AWG Manager: `https://raw.githubusercontent.com/USERNAME/flymater-routing/main/awg/proxy.txt`
- Shadowrocket: `https://raw.githubusercontent.com/USERNAME/flymater-routing/main/shadowrocket/flymater.conf`
- Throne: `https://raw.githubusercontent.com/USERNAME/flymater-routing/main/throne/flymater.json`

В URL используйте реальное имя default branch (в примерах — `main`).

## 3. Подключение AWG Manager 2.16.5

Маршрутизация → NDMS → Создать вручную → название `FlyMater PROXY` → «Подписки»: добавьте URL `awg/proxy.txt` → маршрут: нужный AWG-туннель → сохранить и включить. Настройки → Автообновление подписок DNS: 24 часа. Клиентам нужно использовать DNS роутера. NDMS не обеспечивает такую же очередность DIRECT/PROXY, как sing-box; при конфликтующих правилах проверьте фактический маршрут. Если настроен альтернативный движок, у него другие опции.

## 4. Shadowrocket на iPhone/macOS

В разделе Configuration/Config добавьте удалённый конфигурационный файл по URL `shadowrocket/flymater.conf`, выберите его активным и проверьте, что политика PROXY использует выбранный вами VPN-узел. В версиях и локализациях Shadowrocket названия меню могут отличаться. Не добавляйте CONF как подписку VPN-серверов. Обновление зависит от настроек приложения; при необходимости обновите конфигурацию вручную.

## 5. Throne 1.3.2 на Windows 11

Используйте **удалённый профиль маршрутизации**, а не подписку на прокси-серверы. В `Routing` → `Routing Settings` → `Route` найдите добавление удалённого профиля маршрутизации и укажите URL `throne/flymater.json`. Если удобнее, используйте глубокую ссылку `throne://remoteroute/<base64>` (Base64 из строки `URL#FlyMater Routing`). Выберите профиль активным. В разделе `Basic Settings` → `Subscription` включите `Routing profiles auto update` (по умолчанию выключено). Обновление можно запускать вручную в разделе маршрутизации; после обновления перезапустите подключение для применения правил.

Встроенные стандартные proxy/direct/block должны работать с твоим выбранным сервером. В режиме TUN убедитесь, что DNS перехватывается корректно, иначе доменные правила могут не срабатывать.

## 6. Редактирование

Редактируйте только `source/local.txt`, `source/proxy.txt`, `source/direct.txt`, `source/reject.txt`: по одному домену в строке, без `DOMAIN-SUFFIX`, `https://`, `*.`, inline-комментариев. Меняйте в GitHub и жмите Commit. Сгенерированные файлы не редактируйте.

Локально: `python scripts/generate.py` (не нужны дополнительные пакеты).

## Ограничения и безопасность

- Это подписки **на правила**, а не конфигурации VPN и не список ключей/серверов. Не публикуйте ключи, токены или конфигурации с секретами.
- Начальные списки — неполные примеры: вручную перенесите все ваши действующие домены, затем тестируйте на каждом клиенте.
- Политика блокировки `reject` используется после `direct` согласно схеме приоритетов; при необходимости переместите выше.
- RAW NDMS у AWG Manager принимает домены и CIDR; наш генератор специально принимает только домены.
- Прохождение обновления GitHub Actions не гарантирует работоспособность на конкретной версии клиента: проверяйте логи и тестовые домены.
