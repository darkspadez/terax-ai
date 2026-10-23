# oarlock-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) so the host can detect command boundaries and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_oarlock_ret`.

{
  _oarlock_wrapper_zdotdir="$ZDOTDIR"
  _oarlock_had_wrapper_zdotdir="${ZDOTDIR+x}"
  if [ -n "${OARLOCK_USER_ZDOTDIR+x}" ]; then
    export ZDOTDIR="$OARLOCK_USER_ZDOTDIR"
  else
    unset ZDOTDIR
  fi
  _oarlock_user_zdotdir="${ZDOTDIR:-$HOME}"
  if [ -n "$_oarlock_wrapper_zdotdir" ] && [ "${HISTFILE:-}" = "$_oarlock_wrapper_zdotdir/.zsh_history" ]; then
    HISTFILE="$_oarlock_user_zdotdir/.zsh_history"
  fi
  [ -f "$_oarlock_user_zdotdir/.zshrc" ] && source "$_oarlock_user_zdotdir/.zshrc"
  if [ -n "${ZDOTDIR+x}" ]; then
    export OARLOCK_USER_ZDOTDIR="$ZDOTDIR"
  else
    unset OARLOCK_USER_ZDOTDIR
  fi
  if [ -n "$_oarlock_had_wrapper_zdotdir" ]; then
    export ZDOTDIR="$_oarlock_wrapper_zdotdir"
  else
    unset ZDOTDIR
  fi
  unset _oarlock_wrapper_zdotdir _oarlock_had_wrapper_zdotdir _oarlock_user_zdotdir
}

if [[ -n "$OARLOCK_CLI" && -x "$OARLOCK_CLI" ]]; then
  oarlock() {
    command "$OARLOCK_CLI" "$@"
  }
fi

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks — desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__OARLOCK_HOOKS_LOADED" ]]; then
  __OARLOCK_HOOKS_LOADED=1
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _oarlock_urlencode() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [a-zA-Z0-9/._~-]) printf '%s' "$byte" ;;
        *) printf '%%%02X' "'$byte" ;;
      esac
    done
  }

  _oarlock_precmd() {
    local _oarlock_ret=$?
    printf '\e]133;D;%s\e\\' "$_oarlock_ret"
    printf '\e]7;file://%s%s\e\\' "${HOST}" "$(_oarlock_urlencode "$PWD")"
    # In block mode the host renders its own input bar, so suppress the shell
    # prompt entirely (keep only the OSC 133 B marker) and add a leading blank
    # line so frozen command blocks get vertical breathing room.
    if [[ -n "$OARLOCK_BLOCKS" ]]; then
      # Spacing reserved for the host-drawn block header lives in the prompt
      # (the grid is WebGL, not CSS). Later prompts get two blank rows: the
      # upper one is the previous block's end gap (above its divider), the lower
      # one is this command's header row. The very first prompt has no block
      # above it, so it gets a single row (header only) to avoid a tall top gap.
      if [[ -n "$_oarlock_block_seen" ]]; then
        PS1=$'\n\n%{\e]133;B\e\\%}'
      else
        PS1=$'\n%{\e]133;B\e\\%}'
      fi
      RPROMPT=''
    elif [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A\e\\'
  }

  _oarlock_preexec() {
    # Mark that a real command ran, so the next prompt switches from one blank
    # row (first prompt, no block above) to two (end gap + header row).
    [[ -n "$OARLOCK_BLOCKS" ]] && _oarlock_block_seen=1
    local cmd="${1//[[:cntrl:]]/ }"
    printf '\e]133;C;%s\e\\' "${cmd[1,256]}"
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _oarlock_precmd
    add-zsh-hook preexec _oarlock_preexec
  fi

  # Warp/iTerm2-style word-end navigation: zsh's default `forward-word` (M-f /
  # Option+Right) overshoots to the START of the next word; `emacs-forward-word`
  # stops at the END of the current word, which is what nearly every other shell
  # and GUI editor does. Only rebind when the binding is still the stock zsh
  # default — respects any explicit remap in the user's .zshrc.
  if (( $+widgets[emacs-forward-word] )) \
     && [[ "$(bindkey '\ef')" == '"^[f" forward-word' ]]; then
    bindkey '\ef' emacs-forward-word
  fi

  _oarlock_precmd
fi
:
