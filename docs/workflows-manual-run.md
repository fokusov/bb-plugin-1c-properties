# Ручной запуск оркестрации через BB Workflows

`workflows/orchestrate-approved-plan.js` запускает до восьми независимых пишущих исполнителей, а затем одного интегратора для успешных результатов. Перед запуском утверди общий план, список задач, границы файлов/поведения и рабочую ветку интеграции. Сам Workflows не создаёт Git worktree: подготовь их заранее и передай точные пути. Запускать его нужно из BB-треда проекта, чьё окружение видит все эти worktree.

## Подготовка Git

В PowerShell задай корень проекта, базовую ветку и пути ниже. Для каждого worktree создай отдельную ветку от одного и того же `baseRef`; интеграционную ветку тоже создай от этой базы. Все каталоги должны быть новыми, а исходная рабочая копия и базовая ветка — чистыми.

```powershell
$repo = (Resolve-Path 'C:\work\my-project').Path
$baseRef = 'main'
$integrationBranch = 'orchestration/task-2026-11-25-integration'
$runRoot = Join-Path $repo '.bb\orchestration\task-2026-11-25'
$integrationPath = Join-Path $runRoot 'integration'
$taskOnePath = Join-Path $runRoot 'task-one'
$taskTwoPath = Join-Path $runRoot 'task-two'

if ((git -C $repo status --porcelain).Length -ne 0) { throw 'Исходная рабочая копия должна быть чистой' }
git -C $repo rev-parse --verify "$baseRef^{commit}"
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
git -C $repo worktree add -b $integrationBranch $integrationPath $baseRef
git -C $repo worktree add -b 'orchestration/task-2026-11-25-one' $taskOnePath $baseRef
git -C $repo worktree add -b 'orchestration/task-2026-11-25-two' $taskTwoPath $baseRef
```

Если исходная копия не чистая или каталог уже существует, остановись и выбери чистую копию/новые пути. Укажи задачам непересекающиеся разрешённые области, чтобы исполнители не редактировали один и тот же файл. Оставь worktree внутри workspace текущего BB environment, чтобы рабочие треды могли к ним обратиться.

## Запуск

Возьми `parentThreadId` из `bb status` и заполни ID проекта и окружения. Укажи путь к шаблону `workflows/orchestrate-approved-plan.js` из checkout плагина, доступного на машине треда. Замени пример плана, ролей и команд на утверждённые для своей работы.

```powershell
$argsJson = @{
  taskId = 'feature-123'
  parentThreadId = 'thr_parent_from_bb_status'
  projectId = 'proj_project_id'
  environmentId = 'env_environment_id'
  integrationWorktreePath = $integrationPath
  integrationBranch = $integrationBranch
  plan = 'Утверждённый план целиком'
  verificationCommand = 'команды проверки проекта; без production-операций'
  tasks = @(
    @{
      taskId = 'feature-123-a'
      role = 'Исполнитель API'
      title = 'Изменить API-адаптер'
      worktreePath = $taskOnePath
      branch = 'orchestration/task-2026-11-25-one'
      approvedScope = 'Только src/api/** и относящиеся к нему тесты'
    },
    @{
      taskId = 'feature-123-b'
      role = 'Исполнитель UI'
      title = 'Обновить форму'
      worktreePath = $taskTwoPath
      branch = 'orchestration/task-2026-11-25-two'
      approvedScope = 'Только src/ui/** и относящиеся к нему тесты'
    }
  )
} | ConvertTo-Json -Depth 8 -Compress

node $env:BB_CLI workflows run --file .\bb-plugin-1c-properties\workflows\orchestrate-approved-plan.js --args $argsJson
```

Для вызова Workflows из PowerShell используй JS entrypoint в `$env:BB_CLI`: наблюдаемый `bb.cmd` терял кавычки из inline JavaScript/JSON и ломал разбор аргументов.

Пишущие исполнители и интегратор наследуют provider, model, reasoning level и permission mode исходного треда: штатный Workflows не принимает динамический tuple из args. Если нужен конкретный tuple, запускай workflow из BB-треда, уже настроенного на него. Не запускай workflow с неутверждённым планом или чужими/пользовательскими изменениями в worktree.

## Статус, результаты и завершение

Команда запуска возвращает `runId`. Отслеживай итог через:

```powershell
bb workflows status <run-id>
bb workflows history <run-id> --cursor 0 --limit 100
```

History может содержать промпты и результаты. Для подробного разбора сохраняй JSONL в `$env:BB_THREAD_STORAGE` и открывай файл локально, не печатай всю историю в общий чат. Если запуск завис/стал ненужен, останови точный run ID командой `bb workflows stop <run-id>`.

Результат содержит статус по каждой задаче и интеграцию/проверки. Если один исполнитель упал, его задача отмечается `failed`, успешные задачи всё ещё передаются интегратору. Если успешных задач нет, интегратор пропускается. При конфликте, грязной интеграционной ветке или превышении утверждённого scope интегратор должен вернуть `failed` без перезаписи изменений. Проверь итоговый `git status` и diff в integration worktree. Worktree исполнителей содержат исходные патчи и сохраняются до твоего решения; не удаляй их до сохранения нужных результатов. Шаблон не создаёт коммитов, не делает push, merge в общую ветку или deploy.

## Ограничения штатного Workflows

- Рабочие треды Workflows скрытые и принадлежат плагину `workflows`; панель может не показать их как обычных видимых исполнителей.
- `agent()` допускает model tuple только как литералы в коде; нельзя задать произвольный provider/model/reasoningLevel аргументом запуска. Worker наследует tuple и режим доступа исходного треда.
- Каждый вызов виден в собственных `bb workflows status/history` с run ID и child thread ID. Связь к task role или `1c-properties.orchestration` arbitrary metadata через `agent()` не поддерживается документированными опциями шаблона.
- Workflows наследует проект и environment исходного треда. `projectId`, `environmentId`, `parentThreadId` и `taskId` в args передаются как контекст/корреляционные поля, но не меняют этот scope и сами по себе не записывают метаданные BB.
- Worktree изолируют записи только если они заранее созданы и исполнители соблюдают указанные пути. Платформа Workflows не закрепляет агента за отдельным worktree и не выполняет файловую изоляцию.
- Результат интегратора — проверяемые незакоммиченные изменения в integration worktree. Ревью, обязательные проверки проекта и отдельное решение о коммите/слиянии остаются за владельцем проекта.
