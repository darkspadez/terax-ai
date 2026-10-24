; Explorer integration for the current user (HKCU, the installer's currentUser
; scope): "Open in Oarlock" on folders, folder backgrounds and drives, and Oarlock
; under "Open with" for text and code files. Oarlock is only listed for those
; types (OpenWithProgids, Applications\oarlock.exe SupportedTypes), never made
; their default app, and uninstalling removes every key written here.
; %V = clicked path. NoWorkingDirectory keeps Explorer from overriding %V
; (System32 on Drive). Needs NSIS 3.06+ (DeleteRegKey /ifempty checks values).

!define OARLOCK_EXE "oarlock.exe"
!define OARLOCK_PROGID "Oarlock Document"
!define OARLOCK_APP_KEY "Software\Classes\Applications\${OARLOCK_EXE}"

!macro OARLOCK_ADD_FOLDER_VERB CLASS
  WriteRegStr HKCU "Software\Classes\${CLASS}\shell\OpenInOarlock" "" "Open in Oarlock"
  WriteRegStr HKCU "Software\Classes\${CLASS}\shell\OpenInOarlock" "Icon" '"$INSTDIR\${OARLOCK_EXE}",0'
  WriteRegStr HKCU "Software\Classes\${CLASS}\shell\OpenInOarlock" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\${CLASS}\shell\OpenInOarlock\command" "" '"$INSTDIR\${OARLOCK_EXE}" "%V"'
!macroend

!macro OARLOCK_REMOVE_FOLDER_VERB CLASS
  DeleteRegKey HKCU "Software\Classes\${CLASS}\shell\OpenInOarlock"
!macroend

; The text and code types Oarlock is offered for. Keep in step with the
; extensions in Info.plist (src/app/os-integration.test.ts checks).
!macro OARLOCK_TEXT_TYPES MACRO
  !insertmacro ${MACRO} json
  !insertmacro ${MACRO} jsonc
  !insertmacro ${MACRO} txt
  !insertmacro ${MACRO} log
  !insertmacro ${MACRO} csv
  !insertmacro ${MACRO} tsv
  !insertmacro ${MACRO} md
  !insertmacro ${MACRO} markdown
  !insertmacro ${MACRO} mdx
  !insertmacro ${MACRO} js
  !insertmacro ${MACRO} mjs
  !insertmacro ${MACRO} cjs
  !insertmacro ${MACRO} jsx
  !insertmacro ${MACRO} ts
  !insertmacro ${MACRO} tsx
  !insertmacro ${MACRO} mts
  !insertmacro ${MACRO} cts
  !insertmacro ${MACRO} java
  !insertmacro ${MACRO} kt
  !insertmacro ${MACRO} kts
  !insertmacro ${MACRO} gradle
  !insertmacro ${MACRO} py
  !insertmacro ${MACRO} rb
  !insertmacro ${MACRO} php
  !insertmacro ${MACRO} go
  !insertmacro ${MACRO} rs
  !insertmacro ${MACRO} swift
  !insertmacro ${MACRO} dart
  !insertmacro ${MACRO} lua
  !insertmacro ${MACRO} c
  !insertmacro ${MACRO} h
  !insertmacro ${MACRO} cpp
  !insertmacro ${MACRO} cc
  !insertmacro ${MACRO} hpp
  !insertmacro ${MACRO} hh
  !insertmacro ${MACRO} cs
  !insertmacro ${MACRO} html
  !insertmacro ${MACRO} htm
  !insertmacro ${MACRO} css
  !insertmacro ${MACRO} scss
  !insertmacro ${MACRO} sass
  !insertmacro ${MACRO} less
  !insertmacro ${MACRO} vue
  !insertmacro ${MACRO} svelte
  !insertmacro ${MACRO} xml
  !insertmacro ${MACRO} yaml
  !insertmacro ${MACRO} yml
  !insertmacro ${MACRO} toml
  !insertmacro ${MACRO} ini
  !insertmacro ${MACRO} cfg
  !insertmacro ${MACRO} conf
  !insertmacro ${MACRO} properties
  !insertmacro ${MACRO} sh
  !insertmacro ${MACRO} bash
  !insertmacro ${MACRO} zsh
  !insertmacro ${MACRO} sql
  !insertmacro ${MACRO} graphql
  !insertmacro ${MACRO} proto
!macroend

!macro OARLOCK_LIST_TYPE EXT
  WriteRegNone HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${OARLOCK_PROGID}"
  WriteRegStr HKCU "${OARLOCK_APP_KEY}\SupportedTypes" ".${EXT}" ""
!macroend

!macro OARLOCK_UNLIST_TYPE EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${OARLOCK_PROGID}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OARLOCK_ADD_FOLDER_VERB "Directory"
  !insertmacro OARLOCK_ADD_FOLDER_VERB "Directory\Background"
  !insertmacro OARLOCK_ADD_FOLDER_VERB "Drive"

  ; Rewritten whole, so nothing an earlier version wrote lingers.
  DeleteRegKey HKCU "Software\Classes\${OARLOCK_PROGID}"
  WriteRegStr HKCU "Software\Classes\${OARLOCK_PROGID}" "" "Oarlock Document"
  WriteRegStr HKCU "Software\Classes\${OARLOCK_PROGID}\DefaultIcon" "" '"$INSTDIR\${OARLOCK_EXE}",0'
  WriteRegStr HKCU "Software\Classes\${OARLOCK_PROGID}\shell\open\command" "" '"$INSTDIR\${OARLOCK_EXE}" "%1"'

  ; SupportedTypes keeps Oarlock out of "Choose another app" for other types.
  DeleteRegKey HKCU "${OARLOCK_APP_KEY}"
  WriteRegStr HKCU "${OARLOCK_APP_KEY}" "FriendlyAppName" "Oarlock"
  WriteRegStr HKCU "${OARLOCK_APP_KEY}\DefaultIcon" "" '"$INSTDIR\${OARLOCK_EXE}",0'
  WriteRegStr HKCU "${OARLOCK_APP_KEY}\shell\open\command" "" '"$INSTDIR\${OARLOCK_EXE}" "%1"'

  !insertmacro OARLOCK_TEXT_TYPES OARLOCK_LIST_TYPE
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro OARLOCK_REMOVE_FOLDER_VERB "Directory"
  !insertmacro OARLOCK_REMOVE_FOLDER_VERB "Directory\Background"
  !insertmacro OARLOCK_REMOVE_FOLDER_VERB "Drive"

  !insertmacro OARLOCK_TEXT_TYPES OARLOCK_UNLIST_TYPE
  DeleteRegKey HKCU "Software\Classes\${OARLOCK_PROGID}"
  DeleteRegKey HKCU "${OARLOCK_APP_KEY}"
  !insertmacro UPDATEFILEASSOC
!macroend
