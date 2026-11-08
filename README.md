# FlyMater Routing

Подписки содержат правила маршрутизации для AWG Manager (Keenetic/Netcraze), Shadowrocket (iPhone/macOS) и Throne (Windows 11). Для подключения нужен уже настроенный VPN.

## Ссылки для устройств

| Клиент | Подписка |
| --- | --- |
| AWG Manager NDMS | [Домены и подсети PROXY](https://raw.githubusercontent.com/FlyMater/flymater-routing/main/awg/proxy.txt) |
| AWG Manager sing-box Router | [PROXY](https://raw.githubusercontent.com/FlyMater/flymater-routing/main/singbox/proxy.srs) · [DIRECT](https://raw.githubusercontent.com/FlyMater/flymater-routing/main/singbox/direct.srs) · [REJECT](https://raw.githubusercontent.com/FlyMater/flymater-routing/main/singbox/reject.srs) |
| Shadowrocket | [Конфигурация правил](https://raw.githubusercontent.com/FlyMater/flymater-routing/main/shadowrocket/flymater-rounting.conf) |
| Throne | [Профиль маршрутизации](https://raw.githubusercontent.com/FlyMater/flymater-routing/main/throne/flymater-rounting.json) |

Для своей копии проекта замените `FlyMater/flymater-routing` в ссылках на владельца и имя своего репозитория.

## Подключение AWG Manager 2.16.5

Маршрутизация → NDMS → Создать вручную → название `FlyMater PROXY` → «Подписки»: добавьте URL `awg/proxy.txt` → маршрут: нужный AWG-туннель → сохранить и включить. Настройки → Автообновление подписок DNS: 24 часа. Клиентам нужно использовать DNS роутера. NDMS не обеспечивает такую же очередность DIRECT/PROXY, как sing-box; при конфликтующих правилах проверьте фактический маршрут. Если настроен альтернативный движок, у него другие опции.

Для **sing-box Router** добавьте три remote rule sets по ссылкам PROXY, DIRECT и REJECT из [таблицы ссылок для устройств](#ссылки-для-устройств). Выберите формат binary и интервал обновления. Привяжите PROXY к нужному туннелю, DIRECT к прямому выходу, а REJECT к блокировке. Примените настройки на роутере.

## Shadowrocket на iPhone/macOS

В разделе Configuration/Config добавьте удалённый конфигурационный файл по URL `shadowrocket/flymater-rounting.conf`, выберите его активным и проверьте, что политика PROXY использует выбранный вами VPN-узел. В версиях и локализациях Shadowrocket названия меню могут отличаться. Не добавляйте CONF как подписку VPN-серверов. Обновление зависит от настроек приложения; при необходимости обновите конфигурацию вручную.

## Throne 1.3.2 на Windows 11

Используйте **удалённый профиль маршрутизации**, а не подписку на прокси-серверы. В `Routing` → `Routing Settings` → `Route` найдите добавление удалённого профиля маршрутизации и укажите URL `throne/flymater-rounting.json`. Если удобнее, используйте глубокую ссылку `throne://remoteroute/<base64>` (Base64 из строки `URL#FlyMater Routing`). Выберите профиль активным. В разделе `Basic Settings` → `Subscription` включите `Routing profiles auto update` (по умолчанию выключено). Обновление можно запускать вручную в разделе маршрутизации; после обновления перезапустите подключение для применения правил.

Встроенные стандартные proxy/direct/block должны работать с выбранным вами сервером. В режиме TUN убедитесь, что DNS перехватывается корректно, иначе доменные правила могут не срабатывать.
