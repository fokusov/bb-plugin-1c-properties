# Редактор исходников в BB

Вкладка **1С** открывается в потоке с назначенной рабочей папкой. Для файлов и Git используется машина и worktree этого потока. Доступны дерево файлов и метаданных EDT, XML-выгрузки Конфигуратора и пообъектной выгрузки. Сохранение выполняется по **Ctrl+S**, переход к определению — по **F12**. Пункт **Добавить к обсуждению** вставляет в композер путь и диапазон выделенных строк.

## Переход с отдельного плагина

1. Обновите `1c-properties` до сборки с редактором. Сохраните открытые правки в старом редакторе.
2. Перенесите настройки из `bsl-editor` в `1c-properties` в BB или через PowerShell.

   ```powershell
   $oldEditorSettings = (bb plugin config bsl-editor --json | ConvertFrom-Json).values
   bb plugin config 1c-properties set interceptChatOpen ($oldEditorSettings.interceptChatOpen.ToString().ToLowerInvariant())
   if ($oldEditorSettings.gitPath) {
       bb plugin config 1c-properties set gitPath $oldEditorSettings.gitPath
   } else {
       bb plugin config 1c-properties unset gitPath
   }
   bb plugin config 1c-properties set gitReadTimeoutSec ($oldEditorSettings.gitReadTimeoutSec.ToString())
   ```

3. Отключите старый плагин командой `bb plugin disable bsl-editor`. Установленный `bsl-editor` сохраняет свои настройки для отката. Если нужен перенос отметок просмотренных изменений, на каждой машине с worktree скопируйте файл `plugins/bsl-editor/host-data/reviewed.json` в `plugins/1c-properties/host-data/editor/reviewed.json` относительно каталога данных BB на этой машине. Копируйте после отключения старого плагина и до первой работы с отметками в новом. Существующий файл назначения сначала сохраните как резервную копию. Отметки привязаны к пути worktree и ревизии Git.
4. Откройте тред и вкладку **1С**. Если для BSL/XML в BB был закреплён открыватель старого плагина, выберите **Редактор 1С** в настройках открывателей файлов. Там же можно вернуть стандартное превью BB.

Пока включён `bsl-editor`, он обслуживает вкладку **1С**. Встроенный редактор скрывает свою вкладку и блокирует свои файловые операции. BB может показывать оба варианта в меню открывателей, поэтому в период перехода для старого редактора выбирайте **1С-редактор**.

## Откат

Сохраните открытые правки и выполните `bb plugin enable bsl-editor`. Старая вкладка снова станет доступна. Если остался закреплённый открыватель нового плагина, выберите **1С-редактор**. При необходимости перенесите три настройки и файл отметок обратно, предварительно сохранив копию файла назначения. Настройки подключения и BSL Flow продолжают храниться в проекте.

## Ресурсы

Редактор основан на порте [DSH-CodeEditor_BSL](https://github.com/Mempemp/DSH-CodeEditor_BSL). Лицензия порта лежит в [editor/LICENSE](../editor/LICENSE). Дерево и иконки метаданных восходят к [1C Metadata Viewer](https://github.com/zerobig/vscode-1c-metadata-viewer). В комплект включены локальная сборка [Monaco 0.52.2](https://github.com/microsoft/monaco-editor/tree/v0.52.2), грамматики из [Language 1C (BSL)](https://github.com/1c-syntax/vsc-language-1c-bsl) и зависимости TextMate. Лицензии точных версий и сторонние уведомления находятся в [editor/licenses](../editor/licenses/).
