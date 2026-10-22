# terax-shell-integration (zlogin)
#
# This is the LAST init file zsh runs before entering the prompt loop, so its
# exit status becomes `$?` for the very first prompt. Without the trailing `:`,
# users without a personal ~/.zlogin (the common case) hit a non-zero $? on
# first render — themes that condition prompt color on `%?` (robbyrussell etc.)
# show a red error indicator on a clean shell start.
{
  _terax_wrapper_zdotdir="$ZDOTDIR"
  _terax_had_wrapper_zdotdir="${ZDOTDIR+x}"
  if [ -n "${TERAX_USER_ZDOTDIR+x}" ]; then
    export ZDOTDIR="$TERAX_USER_ZDOTDIR"
  else
    unset ZDOTDIR
  fi
  _terax_user_zdotdir="${ZDOTDIR:-$HOME}"
  if [ -n "$_terax_wrapper_zdotdir" ] && [ "${HISTFILE:-}" = "$_terax_wrapper_zdotdir/.zsh_history" ]; then
    HISTFILE="$_terax_user_zdotdir/.zsh_history"
  fi
  [ -f "$_terax_user_zdotdir/.zlogin" ] && source "$_terax_user_zdotdir/.zlogin"
  if [ -n "${ZDOTDIR+x}" ]; then
    export TERAX_USER_ZDOTDIR="$ZDOTDIR"
  else
    unset TERAX_USER_ZDOTDIR
  fi
  if [ -n "$_terax_had_wrapper_zdotdir" ]; then
    export ZDOTDIR="$_terax_wrapper_zdotdir"
  else
    unset ZDOTDIR
  fi
  unset _terax_wrapper_zdotdir _terax_had_wrapper_zdotdir _terax_user_zdotdir
}
:
