; Explorer integration for the current user (HKCU, the installer's currentUser
; scope): "Open in Terax" on folders, folder backgrounds and drives, and Terax
; under "Open with" for text and code files. Terax is only listed for those
; types (OpenWithProgids, Applications\terax.exe SupportedTypes), never made
; their default app, and uninstalling removes every key written here.
; %V = clicked path. NoWorkingDirectory keeps Explorer from overriding %V
; (System32 on Drive). Needs NSIS 3.06+ (DeleteRegKey /ifempty checks values).

!define TERAX_EXE "terax.exe"
!define TERAX_PROGID "Terax Document"
!define TERAX_APP_KEY "Software\Classes\Applications\${TERAX_EXE}"

!macro TERAX_ADD_FOLDER_VERB CLASS
  WriteRegStr HKCU "Software\Classes\${CLASS}\shell\OpenInTerax" "" "Open in Terax"
  WriteRegStr HKCU "Software\Classes\${CLASS}\shell\OpenInTerax" "Icon" '"$INSTDIR\${TERAX_EXE}",0'
  WriteRegStr HKCU "Software\Classes\${CLASS}\shell\OpenInTerax" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\${CLASS}\shell\OpenInTerax\command" "" '"$INSTDIR\${TERAX_EXE}" "%V"'
!macroend

!macro TERAX_REMOVE_FOLDER_VERB CLASS
  DeleteRegKey HKCU "Software\Classes\${CLASS}\shell\OpenInTerax"
!macroend

; The text and code types Terax is offered for. Keep in step with the
; extensions in Info.plist (src/app/os-integration.test.ts checks).
!macro TERAX_TEXT_TYPES MACRO
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

!macro TERAX_LIST_TYPE EXT
  WriteRegNone HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${TERAX_PROGID}"
  WriteRegStr HKCU "${TERAX_APP_KEY}\SupportedTypes" ".${EXT}" ""
!macroend

!macro TERAX_UNLIST_TYPE EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${TERAX_PROGID}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}"
!macroend

; Earlier installers (Tauri's bundle.fileAssociations) made Terax the default
; app for these types; give each back the default it had before, else none.
!macro TERAX_RELEASE_LEGACY_DEFAULT EXT
  ReadRegStr $R0 HKCU "Software\Classes\.${EXT}" ""
  ${If} $R0 == "${TERAX_PROGID}"
    ReadRegStr $R1 HKCU "Software\Classes\.${EXT}" "${TERAX_PROGID}_backup"
    ${If} $R1 == ""
    ${OrIf} $R1 == "${TERAX_PROGID}"
      DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
    ${Else}
      WriteRegStr HKCU "Software\Classes\.${EXT}" "" $R1
    ${EndIf}
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.${EXT}" "${TERAX_PROGID}_backup"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1

  !insertmacro TERAX_ADD_FOLDER_VERB "Directory"
  !insertmacro TERAX_ADD_FOLDER_VERB "Directory\Background"
  !insertmacro TERAX_ADD_FOLDER_VERB "Drive"

  !insertmacro TERAX_TEXT_TYPES TERAX_RELEASE_LEGACY_DEFAULT

  ; Rewritten whole, so nothing an earlier version wrote lingers.
  DeleteRegKey HKCU "Software\Classes\${TERAX_PROGID}"
  WriteRegStr HKCU "Software\Classes\${TERAX_PROGID}" "" "Terax Document"
  WriteRegStr HKCU "Software\Classes\${TERAX_PROGID}\DefaultIcon" "" '"$INSTDIR\${TERAX_EXE}",0'
  WriteRegStr HKCU "Software\Classes\${TERAX_PROGID}\shell\open\command" "" '"$INSTDIR\${TERAX_EXE}" "%1"'

  ; SupportedTypes keeps Terax out of "Choose another app" for other types.
  DeleteRegKey HKCU "${TERAX_APP_KEY}"
  WriteRegStr HKCU "${TERAX_APP_KEY}" "FriendlyAppName" "Terax"
  WriteRegStr HKCU "${TERAX_APP_KEY}\DefaultIcon" "" '"$INSTDIR\${TERAX_EXE}",0'
  WriteRegStr HKCU "${TERAX_APP_KEY}\shell\open\command" "" '"$INSTDIR\${TERAX_EXE}" "%1"'

  !insertmacro TERAX_TEXT_TYPES TERAX_LIST_TYPE
  !insertmacro UPDATEFILEASSOC

  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $R0
  Push $R1

  !insertmacro TERAX_REMOVE_FOLDER_VERB "Directory"
  !insertmacro TERAX_REMOVE_FOLDER_VERB "Directory\Background"
  !insertmacro TERAX_REMOVE_FOLDER_VERB "Drive"

  !insertmacro TERAX_TEXT_TYPES TERAX_RELEASE_LEGACY_DEFAULT
  !insertmacro TERAX_TEXT_TYPES TERAX_UNLIST_TYPE
  DeleteRegKey HKCU "Software\Classes\${TERAX_PROGID}"
  DeleteRegKey HKCU "${TERAX_APP_KEY}"
  !insertmacro UPDATEFILEASSOC

  Pop $R1
  Pop $R0
!macroend
