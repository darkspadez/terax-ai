# oarlock-shell-integration (zshenv)
#
# Trailing `:` is load-bearing — without it, a missing user .zshenv leaves $?=1,
# which propagates through the rest of init and ultimately into the first
# prompt's `%?` (rendering robbyrussell's `➜` red on a clean shell start).
#
# Every wrapper sources the user's file under the user's own ZDOTDIR (or none),
# so `$ZDOTDIR/conf.d/*` and `${ZDOTDIR:-$HOME}/.zsh_history` resolve as in any
# terminal. A ZDOTDIR the user's file sets is carried in OARLOCK_USER_ZDOTDIR, and
# ZDOTDIR points back here afterwards so zsh still loads the next wrapper. A
# HISTFILE derived from this directory (macOS /etc/zshrc) moves to the user's.
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
  [ -f "$_oarlock_user_zdotdir/.zshenv" ] && source "$_oarlock_user_zdotdir/.zshenv"
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
