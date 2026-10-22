@echo off
rem terax-shell-integration (cmd.exe), run with `cmd /k` after AutoRun.
rem Wraps PROMPT to emit OSC 133 D/A, OSC 7 (cwd) and OSC 133 B. cmd has no
rem preexec hook (no OSC 133 C) and $P is written as is, so block tabs keep
rem this prompt (terax_blocks=0) instead of the shared command bar.
if not defined PROMPT set "PROMPT=$P$G"
rem Already wrapped (sourced again, or a cmd started from this one).
if not "%PROMPT:]133;A=%"=="%PROMPT%" goto :eof
set "TERAX_BLOCKS="
if defined TERAX_CLI if exist "%TERAX_CLI%" doskey terax="%TERAX_CLI%" $*
set "PROMPT=$E]133;D$E\$E]133;A$E\$E]7;file://%COMPUTERNAME%/$P$E\%PROMPT%$E]133;B;terax_blocks=0$E\"
