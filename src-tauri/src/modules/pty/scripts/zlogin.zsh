# oarlock-shell-integration (zlogin)
#
# This is the LAST init file zsh runs before entering the prompt loop, so its
# exit status becomes `$?` for the very first prompt. Without the trailing `:`,
# users without a personal ~/.zlogin (the common case) hit a non-zero $? on
# first render — themes that condition prompt color on `%?` (robbyrussell etc.)
# show a red error indicator on a clean shell start.
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
  [ -f "$_oarlock_user_zdotdir/.zlogin" ] && source "$_oarlock_user_zdotdir/.zlogin"
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
:
